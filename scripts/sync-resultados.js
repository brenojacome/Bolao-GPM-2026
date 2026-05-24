/**
 * sync-resultados.js
 * Roda via GitHub Actions (cron + workflow_dispatch).
 * Busca resultados de jogos encerrados na API-Football e atualiza o Supabase.
 */

import { createClient } from '@supabase/supabase-js'
import fetch from 'node-fetch'

const SUPABASE_URL            = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APIFOOTBALL_KEY         = process.env.APIFOOTBALL_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !APIFOOTBALL_KEY) {
  console.error('Variáveis de ambiente ausentes: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APIFOOTBALL_KEY')
  process.exit(1)
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const API_BASE   = 'https://v3.football.api-sports.io'
const API_HEADERS = { 'x-apisports-key': APIFOOTBALL_KEY }
const STATUS_FINAIS = new Set(['FT', 'AET', 'PEN'])

async function apiFetch(path) {
  const url = `${API_BASE}${path}`
  console.log(`[API] GET ${url}`)
  const resp = await fetch(url, { headers: API_HEADERS })

  if (resp.status === 429) {
    await log(null, 'quota_excedida', 'Limite diário da API-Football atingido (429).')
    console.warn('Quota diária excedida — encerrando.')
    process.exit(0)
  }

  if (!resp.ok) {
    throw new Error(`API retornou ${resp.status}: ${await resp.text()}`)
  }
  return resp.json()
}

async function log(jogoId, status, mensagem) {
  const { error } = await db.from('sync_log').insert({ jogo_id: jogoId, status, mensagem })
  if (error) console.error('Erro ao gravar sync_log:', error.message)
}

// ---------- 1. Buscar jogos pendentes ----------
async function buscarJogosPendentes() {
  const limite = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  const { data, error } = await db
    .from('jogos')
    .select('id, apifootball_fixture_id, data_hora, fase, selecao_casa_id, selecao_fora_id')
    .eq('resultado_confirmado', false)
    .not('apifootball_fixture_id', 'is', null)
    .lt('data_hora', limite)
  if (error) throw new Error('Erro ao buscar jogos pendentes: ' + error.message)
  return data ?? []
}

// ---------- 2. Consultar API e obter resultado ----------
async function consultarFixture(fixtureId) {
  const json = await apiFetch(`/fixtures?id=${fixtureId}`)
  const fixture = json.response?.[0]
  if (!fixture) return null

  const status = fixture.fixture?.status?.short
  if (!STATUS_FINAIS.has(status)) return null  // ainda não encerrou

  const ft   = fixture.score?.fulltime   ?? { home: null, away: null }
  const et   = fixture.score?.extratime  ?? { home: null, away: null }
  const pen  = fixture.score?.penalty    ?? { home: null, away: null }

  const teveProrrogacao = status === 'AET' || status === 'PEN'
  const tevePenaltis    = status === 'PEN'

  // Placar final = prorrogação (se houver) ou tempo regulamentar
  const golsCasaFinal = teveProrrogacao && et.home != null ? ft.home + et.home : ft.home
  const golsForaFinal = teveProrrogacao && et.away != null ? ft.away + et.away : ft.away

  return {
    gols_casa_90min: ft.home,
    gols_fora_90min: ft.away,
    gols_casa_final: golsCasaFinal,
    gols_fora_final: golsForaFinal,
    teve_prorrogacao: teveProrrogacao,
    teve_penaltis:    tevePenaltis,
    api_casa_team_id: fixture.teams?.home?.id,
    api_fora_team_id: fixture.teams?.away?.id,
    // Para pênaltis: quem marcou mais pênaltis é o vencedor
    pen_casa: pen.home,
    pen_fora: pen.away,
  }
}

// ---------- 3. Determinar vencedor ----------
async function determinarVencedor(jogo, resultado) {
  const { gols_casa_final, gols_fora_final, pen_casa, pen_fora, teve_penaltis } = resultado

  if (teve_penaltis) {
    // Vencedor pelos pênaltis
    if (pen_casa > pen_fora) return jogo.selecao_casa_id
    if (pen_fora > pen_casa) return jogo.selecao_fora_id
  }

  if (gols_casa_final > gols_fora_final) return jogo.selecao_casa_id
  if (gols_fora_final > gols_casa_final) return jogo.selecao_fora_id
  return null  // empate (fase de grupos)
}

// ---------- 4. Salvar resultado e calcular pontuação ----------
async function salvarResultado(jogo, resultado) {
  const vencedorId = await determinarVencedor(jogo, resultado)

  const { error: updateError } = await db.from('jogos').update({
    gols_casa_90min:    resultado.gols_casa_90min,
    gols_fora_90min:    resultado.gols_fora_90min,
    gols_casa_final:    resultado.gols_casa_final,
    gols_fora_final:    resultado.gols_fora_final,
    teve_prorrogacao:   resultado.teve_prorrogacao,
    teve_penaltis:      resultado.teve_penaltis,
    vencedor_id:        vencedorId,
    resultado_confirmado: true,
    ultima_sync:        new Date().toISOString(),
  }).eq('id', jogo.id)

  if (updateError) throw new Error('Erro ao salvar resultado: ' + updateError.message)

  // Calcular pontuação via RPC
  const { error: rpcError } = await db.rpc('calcular_pontuacao', { p_jogo_id: jogo.id })
  if (rpcError) {
    console.warn(`RPC calcular_pontuacao falhou para jogo ${jogo.id}: ${rpcError.message}`)
  }

  await log(jogo.id, 'ok', `Resultado salvo: ${resultado.gols_casa_90min}–${resultado.gols_fora_90min}`)
  console.log(`✅ Jogo ${jogo.id} confirmado: ${resultado.gols_casa_90min}–${resultado.gols_fora_90min}`)
}

// ---------- 5. Popular mata-mata com classificados dos grupos ----------
async function atualizarChaveamentoMataMata() {
  const { data: gruposJogos } = await db
    .from('jogos')
    .select('id')
    .eq('fase', 'grupos')
    .eq('resultado_confirmado', false)

  // Se ainda existem jogos de grupos sem resultado, não é hora
  if (gruposJogos?.length) return

  const { data: oitavasVazias } = await db
    .from('jogos')
    .select('id')
    .eq('fase', 'oitavas')
    .is('selecao_casa_id', null)

  if (!oitavasVazias?.length) return  // oitavas já populadas

  console.log('🏆 Fase de grupos encerrada — buscando classificados...')

  const json = await apiFetch('/standings?league=1&season=2026')
  if (!json.response?.length) {
    console.warn('Standings não disponíveis ainda.')
    return
  }

  const classificados = []  // { grupo, posicao: 1|2, apifootball_team_id }
  for (const entry of json.response) {
    for (const group of (entry.league?.standings ?? [])) {
      for (const team of group) {
        if (team.rank <= 2) {
          classificados.push({
            grupo: team.group?.replace('Group ', '') ?? '?',
            posicao: team.rank,
            apifootball_team_id: team.team?.id,
          })
        }
      }
    }
  }

  // Buscar selecoes_id a partir dos apifootball_team_id
  const teamIds = classificados.map(c => c.apifootball_team_id).filter(Boolean)
  const { data: selecoes } = await db
    .from('selecoes')
    .select('id, apifootball_team_id, grupo')
    .in('apifootball_team_id', teamIds)

  const byTeamId = Object.fromEntries((selecoes ?? []).map(s => [s.apifootball_team_id, s]))

  console.log(`Classificados encontrados: ${classificados.length}`)
  for (const c of classificados) {
    const sel = byTeamId[c.apifootball_team_id]
    if (sel) {
      console.log(`  Grupo ${c.grupo} · ${c.posicao}º: selecao_id=${sel.id}`)
    }
  }
  // A lógica de atribuição dos confrontos de oitavas depende do chaveamento específico da FIFA 2026.
  // O seed dos jogos de oitavas deve ter campos `chave_casa` e `chave_fora` (ex: "1A", "2B")
  // que indicam a posição/grupo do classificado esperado.
  await log(null, 'ok', `Chaveamento mata-mata verificado. ${classificados.length} classificados encontrados.`)
}

// ---------- Main ----------
async function main() {
  console.log(`\n🔄 Iniciando sincronização em ${new Date().toISOString()}`)

  let processados = 0
  let erros = 0

  try {
    const jogos = await buscarJogosPendentes()
    console.log(`Jogos pendentes: ${jogos.length}`)

    for (const jogo of jogos) {
      try {
        const resultado = await consultarFixture(jogo.apifootball_fixture_id)
        if (!resultado) {
          await log(jogo.id, 'api_pendente', `Fixture ${jogo.apifootball_fixture_id} ainda não finalizado.`)
          console.log(`⏳ Jogo ${jogo.id}: ainda não finalizado.`)
          continue
        }
        await salvarResultado(jogo, resultado)
        processados++
      } catch (err) {
        erros++
        await log(jogo.id, 'erro', err.message)
        console.error(`❌ Jogo ${jogo.id}: ${err.message}`)
      }
    }

    await atualizarChaveamentoMataMata()

  } catch (err) {
    console.error('Erro geral na sincronização:', err)
    await log(null, 'erro', err.message)
    process.exit(1)
  }

  console.log(`\n✅ Sync concluída — ${processados} processados, ${erros} erros.\n`)
}

main()
