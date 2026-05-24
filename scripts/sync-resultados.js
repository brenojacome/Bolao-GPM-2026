/**
 * sync-resultados.js
 * Roda via GitHub Actions (cron + workflow_dispatch).
 *
 * Responsabilidades em cada execução, nesta ordem:
 *  1. sincronizarTodosFixtures()   — popula apifootball_fixture_id e times nos jogos do mata-mata
 *  2. sincronizarResultados()      — confirma placares de jogos encerrados
 *  3. sincronizarClassificacaoGrupos() — atualiza classificacao_grupos após fase de grupos
 */

import { createClient } from '@supabase/supabase-js'
import fetch from 'node-fetch'

const SUPABASE_URL             = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APIFOOTBALL_KEY          = process.env.APIFOOTBALL_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !APIFOOTBALL_KEY) {
  console.error('Variáveis de ambiente ausentes: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APIFOOTBALL_KEY')
  process.exit(1)
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const API_BASE    = 'https://v3.football.api-sports.io'
const API_HEADERS = { 'x-apisports-key': APIFOOTBALL_KEY }
const STATUS_FINAIS = new Set(['FT', 'AET', 'PEN'])
const LEAGUE_ID   = 1      // FIFA World Cup na API-Football
const SEASON      = 2026

// ─── helpers ──────────────────────────────────────────────────────────────────

async function apiFetch(path) {
  const url = `${API_BASE}${path}`
  console.log(`[API] GET ${url}`)
  const resp = await fetch(url, { headers: API_HEADERS })

  if (resp.status === 429) {
    await log(null, 'quota_excedida', 'Limite diário da API-Football atingido (429).')
    console.warn('Quota diária excedida — encerrando.')
    process.exit(0)
  }
  if (!resp.ok) throw new Error(`API retornou ${resp.status}: ${await resp.text()}`)
  return resp.json()
}

async function log(jogoId, status, mensagem) {
  const { error } = await db.from('sync_log').insert({ jogo_id: jogoId, status, mensagem })
  if (error) console.error('Erro ao gravar sync_log:', error.message)
}

// ─── 1. Sincronizar todos os fixtures do torneio ──────────────────────────────
//
// A API-Football libera fixture IDs e os times de mata-mata gradualmente.
// Rodamos isso sempre: para grupo, atualiza fixture_id; para mata-mata,
// preenche também selecao_casa_id / selecao_fora_id quando a API os definir.

async function sincronizarTodosFixtures() {
  console.log('\n📋 Sincronizando fixtures do torneio...')

  const json = await apiFetch(`/fixtures?league=${LEAGUE_ID}&season=${SEASON}`)
  const fixtures = json.response ?? []
  if (!fixtures.length) {
    console.warn('Nenhum fixture retornado pela API.')
    return
  }
  console.log(`  API retornou ${fixtures.length} fixtures`)

  // Mapa apifootball_team_id → selecao.id
  const { data: selecoes } = await db
    .from('selecoes')
    .select('id, apifootball_team_id')
    .not('apifootball_team_id', 'is', null)
  const teamIdToSelecao = Object.fromEntries(
    (selecoes ?? []).map(s => [s.apifootball_team_id, s.id])
  )

  // Jogos que ainda não têm fixture_id (precisam ser vinculados)
  const { data: jogosSemFixture } = await db
    .from('jogos')
    .select('id, fase, selecao_casa_id, selecao_fora_id, data_hora, apifootball_fixture_id')
    .is('apifootball_fixture_id', null)

  // Jogos do mata-mata sem times ainda (precisam ser populados)
  const { data: jogosMataMataVazios } = await db
    .from('jogos')
    .select('id, fase, chave, chave_casa, chave_fora, data_hora')
    .not('fase', 'eq', 'grupos')
    .is('selecao_casa_id', null)

  const semFixture    = jogosSemFixture    ?? []
  const mataMataVazio = jogosMataMataVazios ?? []

  // Índice por (selecao_casa_id, selecao_fora_id) para jogos sem fixture_id
  const jogosByTimes = {}
  for (const j of semFixture) {
    if (j.selecao_casa_id && j.selecao_fora_id) {
      jogosByTimes[`${j.selecao_casa_id}-${j.selecao_fora_id}`] = j
    }
  }

  // Índice por data (dia) para mata-mata vazio
  const jogosPorDia = {}
  for (const j of mataMataVazio) {
    const dia = j.data_hora.slice(0, 10)
    if (!jogosPorDia[dia]) jogosPorDia[dia] = []
    jogosPorDia[dia].push(j)
  }

  let atualizados = 0

  for (const f of fixtures) {
    const fixtureId  = f.fixture?.id
    const homeApiId  = f.teams?.home?.id
    const awayApiId  = f.teams?.away?.id
    const homeId     = teamIdToSelecao[homeApiId]
    const awayId     = teamIdToSelecao[awayApiId]
    const dataFixture = f.fixture?.date?.slice(0, 10)  // "2026-06-11"

    if (!fixtureId) continue

    // Caso 1: jogo de grupos que tem os dois times — só vincula fixture_id
    const chaveGrupo = homeId && awayId ? `${homeId}-${awayId}` : null
    if (chaveGrupo && jogosByTimes[chaveGrupo]) {
      const jogo = jogosByTimes[chaveGrupo]
      const { error } = await db
        .from('jogos')
        .update({ apifootball_fixture_id: fixtureId, ultima_sync: new Date().toISOString() })
        .eq('id', jogo.id)
      if (!error) {
        console.log(`  ✅ fixture_id vinculado: jogo ${jogo.id} → fixture ${fixtureId}`)
        atualizados++
      }
      continue
    }

    // Caso 2: fixture de mata-mata com times já definidos pela API
    // Busca um jogo na mesma data sem times ainda
    if (homeId && awayId && dataFixture) {
      const candidatos = jogosPorDia[dataFixture] ?? []
      if (candidatos.length === 1) {
        // Data única — pode vincular com segurança
        const jogo = candidatos[0]
        const { error } = await db.from('jogos').update({
          selecao_casa_id:       homeId,
          selecao_fora_id:       awayId,
          apifootball_fixture_id: fixtureId,
          ultima_sync:           new Date().toISOString(),
        }).eq('id', jogo.id)
        if (!error) {
          console.log(`  ✅ Mata-mata populado: jogo ${jogo.id} (${jogo.fase}/${jogo.chave}) → fixture ${fixtureId}`)
          jogosPorDia[dataFixture] = candidatos.filter(c => c.id !== jogo.id)
          atualizados++
        }
      } else if (candidatos.length > 1) {
        // Múltiplos jogos no dia: usar horário para desambiguar (margem ±15 min)
        const tsFixture = new Date(f.fixture.date).getTime()
        const match = candidatos.find(c => Math.abs(new Date(c.data_hora).getTime() - tsFixture) < 15 * 60 * 1000)
        if (match) {
          const { error } = await db.from('jogos').update({
            selecao_casa_id:       homeId,
            selecao_fora_id:       awayId,
            apifootball_fixture_id: fixtureId,
            ultima_sync:           new Date().toISOString(),
          }).eq('id', match.id)
          if (!error) {
            console.log(`  ✅ Mata-mata populado: jogo ${match.id} (${match.fase}/${match.chave}) → fixture ${fixtureId}`)
            jogosPorDia[dataFixture] = candidatos.filter(c => c.id !== match.id)
            atualizados++
          }
        }
      }
    }
  }

  console.log(`  Fixtures atualizados: ${atualizados}`)
  if (atualizados > 0) {
    await log(null, 'ok', `${atualizados} fixture(s) vinculado(s)/populado(s)`)
  }
}

// ─── 2. Sincronizar resultados de jogos encerrados ────────────────────────────

async function sincronizarResultados() {
  console.log('\n⚽ Sincronizando resultados...')

  const limite = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  const { data: jogos, error } = await db
    .from('jogos')
    .select('id, apifootball_fixture_id, data_hora, fase, selecao_casa_id, selecao_fora_id')
    .eq('resultado_confirmado', false)
    .not('apifootball_fixture_id', 'is', null)
    .lt('data_hora', limite)
  if (error) throw new Error('Erro ao buscar jogos pendentes: ' + error.message)

  const pendentes = jogos ?? []
  console.log(`  Jogos pendentes: ${pendentes.length}`)

  let processados = 0
  let erros = 0

  for (const jogo of pendentes) {
    try {
      const resultado = await consultarFixture(jogo.apifootball_fixture_id)
      if (!resultado) {
        await log(jogo.id, 'api_pendente', `Fixture ${jogo.apifootball_fixture_id} ainda não finalizado.`)
        console.log(`  ⏳ Jogo ${jogo.id}: ainda não finalizado.`)
        continue
      }
      await salvarResultado(jogo, resultado)
      processados++
    } catch (err) {
      erros++
      await log(jogo.id, 'erro', err.message)
      console.error(`  ❌ Jogo ${jogo.id}: ${err.message}`)
    }
  }

  console.log(`  Processados: ${processados}, Erros: ${erros}`)
}

async function consultarFixture(fixtureId) {
  const json = await apiFetch(`/fixtures?id=${fixtureId}`)
  const fixture = json.response?.[0]
  if (!fixture) return null

  const status = fixture.fixture?.status?.short
  if (!STATUS_FINAIS.has(status)) return null

  const ft  = fixture.score?.fulltime  ?? { home: null, away: null }
  const et  = fixture.score?.extratime ?? { home: null, away: null }
  const pen = fixture.score?.penalty   ?? { home: null, away: null }

  const teveProrrogacao = status === 'AET' || status === 'PEN'
  const tevePenaltis    = status === 'PEN'

  const golsCasaFinal = teveProrrogacao && et.home != null ? ft.home + et.home : ft.home
  const golsForaFinal = teveProrrogacao && et.away != null ? ft.away + et.away : ft.away

  return {
    gols_casa_90min:  ft.home,
    gols_fora_90min:  ft.away,
    gols_casa_final:  golsCasaFinal,
    gols_fora_final:  golsForaFinal,
    teve_prorrogacao: teveProrrogacao,
    teve_penaltis:    tevePenaltis,
    pen_casa:         pen.home,
    pen_fora:         pen.away,
  }
}

function determinarVencedor(jogo, resultado) {
  const { gols_casa_final, gols_fora_final, pen_casa, pen_fora, teve_penaltis } = resultado
  if (teve_penaltis) {
    if (pen_casa > pen_fora) return jogo.selecao_casa_id
    if (pen_fora > pen_casa) return jogo.selecao_fora_id
  }
  if (gols_casa_final > gols_fora_final) return jogo.selecao_casa_id
  if (gols_fora_final > gols_casa_final) return jogo.selecao_fora_id
  return null
}

async function salvarResultado(jogo, resultado) {
  const vencedorId = determinarVencedor(jogo, resultado)

  const { error } = await db.from('jogos').update({
    gols_casa_90min:      resultado.gols_casa_90min,
    gols_fora_90min:      resultado.gols_fora_90min,
    gols_casa_final:      resultado.gols_casa_final,
    gols_fora_final:      resultado.gols_fora_final,
    teve_prorrogacao:     resultado.teve_prorrogacao,
    teve_penaltis:        resultado.teve_penaltis,
    vencedor_id:          vencedorId,
    resultado_confirmado: true,
    ultima_sync:          new Date().toISOString(),
  }).eq('id', jogo.id)
  if (error) throw new Error('Erro ao salvar resultado: ' + error.message)

  const { error: rpcError } = await db.rpc('calcular_pontuacao', { p_jogo_id: jogo.id })
  if (rpcError) console.warn(`  RPC calcular_pontuacao falhou (jogo ${jogo.id}): ${rpcError.message}`)

  await log(jogo.id, 'ok', `Resultado: ${resultado.gols_casa_90min}–${resultado.gols_fora_90min}`)
  console.log(`  ✅ Jogo ${jogo.id} confirmado: ${resultado.gols_casa_90min}–${resultado.gols_fora_90min}`)
}

// ─── 3. Classificação de grupos ───────────────────────────────────────────────
//
// Roda após todos os jogos de grupos estarem confirmados.
// Salva em classificacao_grupos e atualiza palpites_grupos (pontuação).

async function sincronizarClassificacaoGrupos() {
  // Verifica se ainda há jogos de grupos pendentes
  const { data: pendentes } = await db
    .from('jogos')
    .select('id')
    .eq('fase', 'grupos')
    .eq('resultado_confirmado', false)
  if (pendentes?.length) return  // ainda tem jogo de grupo sem resultado

  // Verifica se classificacao_grupos já está preenchida
  const { data: jaClassificados } = await db
    .from('classificacao_grupos')
    .select('id')
    .limit(1)
  if (jaClassificados?.length) return  // já foi processado

  console.log('\n🏆 Fase de grupos encerrada — buscando classificação final...')

  const json = await apiFetch(`/standings?league=${LEAGUE_ID}&season=${SEASON}`)
  if (!json.response?.length) {
    console.warn('  Standings não disponíveis ainda.')
    return
  }

  // Mapa apifootball_team_id → selecao.id
  const { data: selecoes } = await db
    .from('selecoes')
    .select('id, apifootball_team_id')
    .not('apifootball_team_id', 'is', null)
  const teamIdToSelecao = Object.fromEntries(
    (selecoes ?? []).map(s => [s.apifootball_team_id, s.id])
  )

  const rows = []
  for (const entry of json.response) {
    for (const group of (entry.league?.standings ?? [])) {
      for (const team of group) {
        const selecaoId = teamIdToSelecao[team.team?.id]
        const grupo = team.group?.replace('Group ', '') ?? null
        if (selecaoId && grupo && team.rank) {
          rows.push({ grupo, posicao: team.rank, selecao_id: selecaoId })
        }
      }
    }
  }

  if (!rows.length) {
    console.warn('  Nenhum classificado mapeado — verifique apifootball_team_id nas seleções.')
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

  // Calcular pontuação de palpites de grupos
  const { error: rpcError } = await db.rpc('calcular_pontuacao_grupos')
  if (rpcError) {
    console.warn('  RPC calcular_pontuacao_grupos falhou:', rpcError.message)
  } else {
    console.log('  ✅ Pontuação de grupos calculada')
  }

  await log(null, 'ok', `Classificação de grupos salva: ${rows.length} posições.`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔄 Iniciando sincronização — ${new Date().toISOString()}`)

  try {
    await sincronizarTodosFixtures()
    await sincronizarResultados()
    await sincronizarClassificacaoGrupos()
  } catch (err) {
    console.error('Erro geral na sincronização:', err)
    await log(null, 'erro', err.message)
    process.exit(1)
  }

  console.log(`\n✅ Sync concluída — ${new Date().toISOString()}\n`)
}

main()
