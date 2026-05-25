/**
 * sync-resultados.js — Bolão Copa 2026
 *
 * Fonte de verdade: football-data.org /v4/competitions/WC
 *
 * Fluxo em cada execução (cron horário + workflow_dispatch):
 *   1. sincronizarTimes()        — upsert das 48 seleções com grupo e emblema
 *   2. sincronizarJogos()        — upsert dos 104 jogos (cria, atualiza times/horários)
 *   3. processarResultados()     — confirma placares e dispara calcular_pontuacao()
 *   4. sincronizarClassificacao()— standings após fase de grupos → classificacao_grupos
 *                                  + dispara calcular_pontuacao_grupos()
 *
 * Não há seed manual: tudo vem da API.
 */

import { createClient } from '@supabase/supabase-js'
import fetch from 'node-fetch'

const SUPABASE_URL              = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const FOOTBALLDATA_TOKEN        = process.env.FOOTBALLDATA_TOKEN   // X-Auth-Token

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !FOOTBALLDATA_TOKEN) {
  console.error('Variáveis ausentes: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FOOTBALLDATA_TOKEN')
  process.exit(1)
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const API_BASE    = 'https://api.football-data.org/v4'
const API_HEADERS = { 'X-Auth-Token': FOOTBALLDATA_TOKEN }
const COMPETITION = 'WC'
const SEASON      = 2026

// ── Mapeamento de stages da API → campo fase do banco ────────────────────────
const STAGE_TO_FASE = {
  GROUP_STAGE:    'grupos',
  ROUND_OF_16:    'oitavas',
  QUARTER_FINALS: 'quartas',
  SEMI_FINALS:    'semis',
  THIRD_PLACE:    '3lugar',
  FINAL:          'final',
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function apiFetch(path) {
  const url = `${API_BASE}${path}`
  console.log(`[API] GET ${url}`)
  const resp = await fetch(url, { headers: API_HEADERS })

  if (resp.status === 429) {
    const retryAfter = resp.headers.get('X-RequestCounter-Reset') ?? 60
    await dbLog(null, 'quota_excedida', `Rate limit atingido. Retry-After: ${retryAfter}s`)
    console.warn(`Rate limit atingido. Aguardando ${retryAfter}s...`)
    await sleep(Number(retryAfter) * 1000)
    return apiFetch(path)  // uma nova tentativa
  }

  if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text()}`)
  return resp.json()
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function dbLog(jogoId, status, mensagem) {
  const { error } = await db.from('sync_log').insert({ jogo_id: jogoId, status, mensagem })
  if (error) console.error('sync_log error:', error.message)
}

// ── 1. Sincronizar times ──────────────────────────────────────────────────────
//
// A endpoint /teams não retorna grupo. Derivamos o grupo a partir dos jogos
// da fase de grupos (todos os times aparecem em ao menos um).

async function sincronizarTimes(todasAsPartidas) {
  console.log('\n🏳️  Sincronizando times...')

  // Construir mapa teamId → grupo a partir das partidas de grupo
  const grupoDoTime = {}
  for (const m of todasAsPartidas) {
    if (m.stage !== 'GROUP_STAGE' || !m.group) continue
    const grupo = m.group.replace('GROUP_', '')   // "GROUP_A" → "A"
    if (m.homeTeam?.id) grupoDoTime[m.homeTeam.id] = grupo
    if (m.awayTeam?.id) grupoDoTime[m.awayTeam.id] = grupo
  }

  // Buscar lista de times da API para obter emblemas e nomes completos
  const json = await apiFetch(`/competitions/${COMPETITION}/teams?season=${SEASON}`)
  const times = json.teams ?? []

  if (!times.length) {
    console.warn('  Nenhum time retornado pela API.')
    return
  }

  const rows = times.map(t => ({
    footballdata_team_id: t.id,
    nome:    t.name,
    codigo:  t.tla,
    grupo:   grupoDoTime[t.id] ?? null,
    flag_url: t.crest ?? null,
  }))

  const { error } = await db
    .from('selecoes')
    .upsert(rows, { onConflict: 'footballdata_team_id' })

  if (error) throw new Error('Erro ao upsert selecoes: ' + error.message)
  console.log(`  ✅ ${rows.length} seleções sincronizadas`)
}

// ── 2. Sincronizar jogos ──────────────────────────────────────────────────────
//
// Cria jogos novos e atualiza times, datas e outros metadados que mudem.
// Placares são tratados separadamente em processarResultados().

async function sincronizarJogos(todasAsPartidas) {
  console.log('\n📅 Sincronizando jogos...')

  // Mapa footballdata_team_id → id interno (pk da tabela selecoes)
  const { data: selecoes } = await db
    .from('selecoes')
    .select('id, footballdata_team_id')
    .not('footballdata_team_id', 'is', null)

  const teamMap = Object.fromEntries(
    (selecoes ?? []).map(s => [s.footballdata_team_id, s.id])
  )

  const rows = todasAsPartidas.map(m => {
    const fase = STAGE_TO_FASE[m.stage]
    if (!fase) return null  // estágio desconhecido, ignorar

    return {
      footballdata_match_id: m.id,
      fase,
      rodada:          m.stage === 'GROUP_STAGE' ? `Rodada ${m.matchday}` : fase,
      rodada_numero:   m.matchday ?? null,
      grupo:           m.group ? m.group.replace('GROUP_', '') : null,
      selecao_casa_id: m.homeTeam?.id ? (teamMap[m.homeTeam.id] ?? null) : null,
      selecao_fora_id: m.awayTeam?.id ? (teamMap[m.awayTeam.id] ?? null) : null,
      data_hora:       m.utcDate,
      estadio:         m.venue ?? null,
      // cidade não vem na API — fica null até cadastro manual ou futura atualização
    }
  }).filter(Boolean)

  if (!rows.length) {
    console.warn('  Nenhuma partida para sincronizar.')
    return
  }

  const { error } = await db
    .from('jogos')
    .upsert(rows, {
      onConflict:        'footballdata_match_id',
      ignoreDuplicates:  false,   // atualiza sempre (datas/times podem mudar)
    })

  if (error) throw new Error('Erro ao upsert jogos: ' + error.message)
  console.log(`  ✅ ${rows.length} jogos sincronizados`)
}

// ── 3. Processar resultados ───────────────────────────────────────────────────
//
// Para cada partida FINISHED que ainda não está confirmada no banco:
// salva o placar e dispara calcular_pontuacao().
//
// Estrutura de score da football-data.org v4:
//   score.fullTime   → placar aos 90min
//   score.extraTime  → gols marcados SOMENTE na prorrogação (somar ao fullTime para total)
//   score.penalties  → resultado nos pênaltis (não são gols, apenas para saber o vencedor)
//   score.duration   → REGULAR | EXTRA_TIME | PENALTY_SHOOTOUT
//   score.winner     → HOME_TEAM | AWAY_TEAM | DRAW | null

async function processarResultados(todasAsPartidas) {
  console.log('\n⚽ Processando resultados...')

  const finalizadas = todasAsPartidas.filter(m => m.status === 'FINISHED')
  if (!finalizadas.length) {
    console.log('  Nenhuma partida finalizada ainda.')
    return
  }

  // Buscar quais jogos ainda não estão confirmados no banco
  const matchIds = finalizadas.map(m => m.id)
  const { data: jogosPendentes } = await db
    .from('jogos')
    .select('id, footballdata_match_id, selecao_casa_id, selecao_fora_id')
    .in('footballdata_match_id', matchIds)
    .eq('resultado_confirmado', false)

  if (!jogosPendentes?.length) {
    console.log('  Todos os resultados já estão confirmados.')
    return
  }

  // Mapa footballdata_match_id → jogo interno
  const jogoByMatchId = Object.fromEntries(
    jogosPendentes.map(j => [j.footballdata_match_id, j])
  )

  let processados = 0
  let erros = 0

  for (const partida of finalizadas) {
    const jogo = jogoByMatchId[partida.id]
    if (!jogo) continue  // já confirmado

    try {
      await salvarResultado(jogo, partida)
      processados++
    } catch (err) {
      erros++
      await dbLog(jogo.id, 'erro', err.message)
      console.error(`  ❌ Jogo ${jogo.id}: ${err.message}`)
    }
  }

  console.log(`  Processados: ${processados}, Erros: ${erros}`)
}

async function salvarResultado(jogo, partida) {
  const score    = partida.score
  const duration = score.duration   // REGULAR | EXTRA_TIME | PENALTY_SHOOTOUT

  const gols90min_casa = score.fullTime?.home ?? 0
  const gols90min_fora = score.fullTime?.away ?? 0
  const golsET_casa    = score.extraTime?.home ?? 0
  const golsET_fora    = score.extraTime?.away ?? 0
  const penCasa        = score.penalties?.home ?? null
  const penFora        = score.penalties?.away ?? null

  const teveProrrogacao = duration === 'EXTRA_TIME' || duration === 'PENALTY_SHOOTOUT'
  const tevePenaltis    = duration === 'PENALTY_SHOOTOUT'

  // Placar final = 90min + ET (se houver)
  const golsFinal_casa = gols90min_casa + golsET_casa
  const golsFinal_fora = gols90min_fora + golsET_fora

  // Vencedor pelo campo score.winner da API (já considera pênaltis)
  let vencedorId = null
  if (score.winner === 'HOME_TEAM') vencedorId = jogo.selecao_casa_id
  else if (score.winner === 'AWAY_TEAM') vencedorId = jogo.selecao_fora_id

  const { error } = await db.from('jogos').update({
    gols_casa_90min:      gols90min_casa,
    gols_fora_90min:      gols90min_fora,
    gols_casa_final:      golsFinal_casa,
    gols_fora_final:      golsFinal_fora,
    teve_prorrogacao:     teveProrrogacao,
    teve_penaltis:        tevePenaltis,
    vencedor_id:          vencedorId,
    resultado_confirmado: true,
    ultima_sync:          new Date().toISOString(),
  }).eq('id', jogo.id)

  if (error) throw new Error('Erro ao salvar resultado: ' + error.message)

  // Dispara cálculo de pontuação
  const { error: rpcErr } = await db.rpc('calcular_pontuacao', { p_jogo_id: jogo.id })
  if (rpcErr) console.warn(`  RPC calcular_pontuacao falhou (jogo ${jogo.id}): ${rpcErr.message}`)

  const placar = `${gols90min_casa}–${gols90min_fora}${tevePenaltis ? ` (pen ${penCasa}–${penFora})` : teveProrrogacao ? ' (pror.)' : ''}`
  await dbLog(jogo.id, 'ok', `Resultado: ${placar}`)
  console.log(`  ✅ Jogo ${jogo.id}: ${placar}`)
}

// ── 4. Classificação de grupos ────────────────────────────────────────────────
//
// Roda somente após todos os jogos da fase de grupos estarem confirmados.
// Busca /standings, salva em classificacao_grupos e dispara
// calcular_pontuacao_grupos().

async function sincronizarClassificacao() {
  // Verifica se há jogos de grupo ainda pendentes
  const { data: pendentes } = await db
    .from('jogos')
    .select('id')
    .eq('fase', 'grupos')
    .eq('resultado_confirmado', false)

  if (pendentes?.length) return  // fase de grupos ainda em andamento

  // Verifica se já foi processado
  const { data: jaFeito } = await db
    .from('classificacao_grupos')
    .select('id')
    .limit(1)

  if (jaFeito?.length) return

  console.log('\n🏆 Fase de grupos encerrada — sincronizando classificação...')

  const json = await apiFetch(`/competitions/${COMPETITION}/standings?season=${SEASON}`)
  const standings = json.standings ?? []

  if (!standings.length) {
    console.warn('  Standings ainda não disponíveis.')
    return
  }

  // Mapa footballdata_team_id → selecao.id
  const { data: selecoes } = await db
    .from('selecoes')
    .select('id, footballdata_team_id')
    .not('footballdata_team_id', 'is', null)

  const teamMap = Object.fromEntries(
    (selecoes ?? []).map(s => [s.footballdata_team_id, s.id])
  )

  const rows = []
  for (const standing of standings) {
    if (standing.type !== 'TOTAL') continue
    const grupo = standing.group?.replace('GROUP_', '') ?? null
    if (!grupo) continue

    for (const entry of standing.table ?? []) {
      const selecaoId = teamMap[entry.team?.id]
      if (selecaoId && entry.position) {
        rows.push({ grupo, posicao: entry.position, selecao_id: selecaoId })
      }
    }
  }

  if (!rows.length) {
    console.warn('  Nenhuma posição mapeada no standings.')
    return
  }

  const { error } = await db
    .from('classificacao_grupos')
    .upsert(rows, { onConflict: 'grupo,posicao' })

  if (error) {
    console.error('  Erro ao salvar classificacao_grupos:', error.message)
    return
  }

  console.log(`  ✅ ${rows.length} posições salvas em classificacao_grupos`)

  const { error: rpcErr } = await db.rpc('calcular_pontuacao_grupos')
  if (rpcErr) console.warn('  RPC calcular_pontuacao_grupos:', rpcErr.message)
  else console.log('  ✅ Pontuação de grupos calculada')

  await dbLog(null, 'ok', `Classificação de grupos: ${rows.length} posições.`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔄 Sync iniciada — ${new Date().toISOString()}`)

  try {
    // Busca todos os 104 jogos de uma vez (1 requisição)
    const json = await apiFetch(
      `/competitions/${COMPETITION}/matches?season=${SEASON}`
    )
    const todasAsPartidas = json.matches ?? []
    console.log(`  API retornou ${todasAsPartidas.length} partidas`)

    await sincronizarTimes(todasAsPartidas)     // upsert selecoes
    await sincronizarJogos(todasAsPartidas)     // upsert jogos
    await processarResultados(todasAsPartidas)  // confirmar placares
    await sincronizarClassificacao()            // standings pós-grupos

  } catch (err) {
    console.error('Erro geral:', err.message)
    await dbLog(null, 'erro', err.message)
    process.exit(1)
  }

  console.log(`✅ Sync concluída — ${new Date().toISOString()}\n`)
}

main()
