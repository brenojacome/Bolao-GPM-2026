// Listagem de partidas e resultados
const Jogos = (() => {
  const FASES_ORDER = ['grupos', 'oitavas', 'quartas', 'semis', '3lugar', 'final']
  const FASES_LABEL = {
    grupos:   'Fase de Grupos',
    oitavas:  'Oitavas de Final',
    quartas:  'Quartas de Final',
    semis:    'Semifinais',
    '3lugar': 'Disputa de 3º Lugar',
    final:    'Final',
  }

  let _jogos   = []
  let _palpites = {}
  let _pontuacao = {}

  async function load() {
    const [{ data: jogos }, { data: palpites }, { data: pontos }] = await Promise.all([
      db.from('jogos')
        .select('*, selecao_casa:selecao_casa_id(*), selecao_fora:selecao_fora_id(*)')
        .order('data_hora'),
      db.from('palpites')
        .select('jogo_id, gols_casa, gols_fora')
        .eq('user_id', Auth.getUser().id),
      db.from('pontuacao')
        .select('jogo_id, pontos, detalhes')
        .eq('user_id', Auth.getUser().id)
        .eq('categoria', 'jogo'),
    ])

    _jogos = jogos ?? []
    _palpites = Object.fromEntries((palpites ?? []).map(p => [p.jogo_id, p]))
    _pontuacao = Object.fromEntries((pontos ?? []).map(p => [p.jogo_id, p]))
  }

  function getAll()   { return _jogos }
  function getById(id) { return _jogos.find(j => j.id === id) }

  function render() {
    const byFase = {}
    for (const jogo of _jogos) {
      if (!byFase[jogo.fase]) byFase[jogo.fase] = []
      byFase[jogo.fase].push(jogo)
    }

    const sections = FASES_ORDER
      .filter(f => byFase[f]?.length)
      .map(fase => {
        const cards = byFase[fase].map(j => renderJogoCard(j)).join('')
        return `
          <section class="fase-section">
            <h2 class="fase-title">${FASES_LABEL[fase]}</h2>
            ${cards}
          </section>
        `
      })
      .join('')

    return `
      <div class="view">
        <h1 class="view-title">Jogos e Resultados</h1>
        ${sections || '<p class="text-muted">Nenhum jogo cadastrado ainda.</p>'}
      </div>
    `
  }

  function renderJogoCard(jogo) {
    const palpite  = _palpites[jogo.id]
    const pontos   = _pontuacao[jogo.id]
    const bloqueado = new Date() >= new Date(jogo.prazo_palpite)
    const confirmado = jogo.resultado_confirmado

    const nomeCasa = jogo.selecao_casa?.nome ?? 'A definir'
    const nomeFora = jogo.selecao_fora?.nome ?? 'A definir'
    const flagCasa = jogo.selecao_casa?.flag_url ? `<img src="${jogo.selecao_casa.flag_url}" alt="${nomeCasa}" loading="lazy">` : '🏳️'
    const flagFora = jogo.selecao_fora?.flag_url ? `<img src="${jogo.selecao_fora.flag_url}" alt="${nomeFora}" loading="lazy">` : '🏳️'

    let placarEl = '<span class="jogo-placar text-muted">vs</span>'
    if (confirmado) {
      placarEl = `<span class="jogo-placar">${jogo.gols_casa_90min} – ${jogo.gols_fora_90min}</span>`
    } else if (bloqueado) {
      placarEl = `<span class="jogo-placar text-muted">– vs –</span>`
    }

    let infoExtra = ''
    if (confirmado && (jogo.teve_prorrogacao || jogo.teve_penaltis)) {
      const suffix = jogo.teve_penaltis ? 'nos pênaltis' : 'na prorrogação'
      infoExtra = `<span class="text-xs text-muted">(${jogo.gols_casa_final}–${jogo.gols_fora_final} ${suffix})</span>`
    }

    let meuPalpiteEl = ''
    if (palpite && bloqueado) {
      meuPalpiteEl = `<span class="badge ${pontos ? (pontos.pontos === 3 ? 'badge-green' : 'badge-yellow') : 'badge-gray'} text-xs">
        Meu: ${palpite.gols_casa}–${palpite.gols_fora}${pontos ? ` · ${pontos.pontos}pt` : ''}
      </span>`
    }

    const dt = new Date(jogo.data_hora)
    const dtStr = dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) +
                  ' ' + dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

    return `
      <div class="jogo-card" data-jogo-id="${jogo.id}">
        <div class="jogo-selecao casa">
          ${flagCasa}
          <span>${nomeCasa}</span>
        </div>
        <div class="jogo-centro">
          ${placarEl}
          ${infoExtra}
          <span class="jogo-meta">${dtStr}</span>
          <span class="jogo-meta">${jogo.cidade ?? ''}</span>
          ${meuPalpiteEl}
        </div>
        <div class="jogo-selecao fora">
          ${flagFora}
          <span>${nomeFora}</span>
        </div>
      </div>
    `
  }

  return { load, render, getAll, getById }
})()
