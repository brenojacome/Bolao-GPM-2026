// CRUD de palpites — jogo a jogo, grupos e Top 4
const Palpites = (() => {
  const GRUPOS = ['A','B','C','D','E','F','G','H','I','J','K','L']

  let _selecoes     = []
  let _jogosPendentes = []   // jogos ainda abertos para palpite
  let _palpitesGrupos = {}
  let _palpiteTop4    = null

  async function load() {
    const [{ data: selecoes }, { data: grupos }, { data: top4 }] = await Promise.all([
      db.from('selecoes').select('*').order('nome'),
      db.from('palpites_grupos').select('*').eq('user_id', Auth.getUser().id),
      db.from('palpites_top4').select('*').eq('user_id', Auth.getUser().id).maybeSingle(),
    ])

    _selecoes = selecoes ?? []
    _palpitesGrupos = Object.fromEntries((grupos ?? []).map(g => [g.grupo, g]))
    _palpiteTop4 = top4

    const agora = new Date()
    _jogosPendentes = Jogos.getAll().filter(j => agora < new Date(j.prazo_palpite))
  }

  async function salvarPalpiteJogo(jogoId, golsCasa, golsFora) {
    const { error } = await db.from('palpites').upsert(
      { user_id: Auth.getUser().id, jogo_id: jogoId, gols_casa: golsCasa, gols_fora: golsFora },
      { onConflict: 'user_id,jogo_id' }
    )
    if (error) throw error
  }

  async function salvarPalpiteGrupo(grupo, primeiroId, segundoId) {
    const { error } = await db.from('palpites_grupos').upsert(
      { user_id: Auth.getUser().id, grupo, primeiro_id: primeiroId, segundo_id: segundoId },
      { onConflict: 'user_id,grupo' }
    )
    if (error) throw error
    _palpitesGrupos[grupo] = { grupo, primeiro_id: primeiroId, segundo_id: segundoId }
  }

  async function salvarTop4(campea, vice, semi1, semi2) {
    const payload = {
      user_id: Auth.getUser().id,
      campea_id: campea,
      vice_id: vice,
      semi1_id: semi1,
      semi2_id: semi2,
    }
    const { error } = await db.from('palpites_top4').upsert(payload, { onConflict: 'user_id' })
    if (error) throw error
    _palpiteTop4 = payload
  }

  // Limite de palpites de grupos: início do torneio
  function gruposBloqueados() {
    return new Date() >= new Date('2026-06-11T00:00:00Z')
  }

  // Limite de Top 4: início das oitavas — aproximadamente 27/jun/2026 UTC
  function top4Bloqueado() {
    return new Date() >= new Date('2026-06-27T00:00:00Z')
  }

  function render() {
    const jogosPorFase = {}
    for (const jogo of Jogos.getAll()) {
      if (!jogosPorFase[jogo.fase]) jogosPorFase[jogo.fase] = []
      jogosPorFase[jogo.fase].push(jogo)
    }

    return `
      <div class="view">
        <h1 class="view-title">Meus Palpites</h1>

        ${renderSecaoJogos(jogosPorFase)}
        ${renderSecaoGrupos()}
        ${renderSecaoTop4()}
      </div>
    `
  }

  function renderSecaoJogos(jogosPorFase) {
    const FASES_ORDER = ['grupos', 'oitavas', 'quartas', 'semis', '3lugar', 'final']
    const FASES_LABEL = {
      grupos: 'Fase de Grupos', oitavas: 'Oitavas de Final',
      quartas: 'Quartas de Final', semis: 'Semifinais',
      '3lugar': 'Disputa de 3º Lugar', final: 'Final',
    }

    const agora = new Date()

    return FASES_ORDER.filter(f => jogosPorFase[f]?.length).map(fase => {
      const rows = (jogosPorFase[fase] ?? []).map(jogo => {
        const bloqueado = agora >= new Date(jogo.prazo_palpite)
        const confirmado = jogo.resultado_confirmado
        const nomeCasa = jogo.selecao_casa?.nome ?? 'A definir'
        const nomeFora = jogo.selecao_fora?.nome ?? 'A definir'
        const dt = new Date(jogo.data_hora)
        const dtStr = dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) +
                      ' ' + dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

        let statusBadge = ''
        if (confirmado) {
          statusBadge = '<span class="badge badge-green">Pontuado</span>'
        } else if (bloqueado) {
          statusBadge = '<span class="badge badge-red">Bloqueado</span>'
        } else {
          const prazo = new Date(jogo.prazo_palpite)
          statusBadge = `<span class="badge badge-yellow">Até ${prazo.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} de ${prazo.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</span>`
        }

        return `
          <div class="palpite-row" data-jogo-id="${jogo.id}">
            <div class="jogo-selecao fora" style="justify-content:flex-end">
              <span>${nomeCasa}</span>
            </div>
            <div class="palpite-input-wrap">
              <input
                class="palpite-input"
                type="number" min="0" max="99"
                data-jogo="${jogo.id}" data-side="casa"
                ${bloqueado ? 'disabled' : ''}
                placeholder="–"
              />
              <span class="palpite-sep">×</span>
              <input
                class="palpite-input"
                type="number" min="0" max="99"
                data-jogo="${jogo.id}" data-side="fora"
                ${bloqueado ? 'disabled' : ''}
                placeholder="–"
              />
            </div>
            <div class="jogo-selecao">
              <span>${nomeFora}</span>
            </div>
            <div class="palpite-status">
              ${statusBadge}
              <span class="text-xs text-muted">${dtStr}</span>
            </div>
          </div>
        `
      }).join('')

      return `
        <section class="fase-section">
          <h2 class="fase-title">${FASES_LABEL[fase]}</h2>
          ${rows}
        </section>
      `
    }).join('')
  }

  function renderSecaoGrupos() {
    const bloqueado = gruposBloqueados()
    const selOpts = _selecoes.map(s =>
      `<option value="${s.id}">${s.nome} (${s.codigo})</option>`
    ).join('')

    const grupoRows = GRUPOS.map(grupo => {
      const selecoesDoGrupo = _selecoes.filter(s => s.grupo === grupo)
      const opts = selecoesDoGrupo.length
        ? selecoesDoGrupo.map(s => `<option value="${s.id}">${s.nome}</option>`).join('')
        : selOpts
      const palpite = _palpitesGrupos[grupo]

      return `
        <div class="card mb-4">
          <div class="card-header">
            <span class="card-title">Grupo ${grupo}</span>
            ${bloqueado ? '<span class="badge badge-red">Bloqueado</span>' : '<span class="badge badge-yellow">Aberto</span>'}
          </div>
          <div class="card-body">
            <div class="flex gap-4" style="flex-wrap:wrap">
              <div class="form-group" style="flex:1;min-width:140px">
                <label class="form-label">1º Colocado</label>
                <select class="form-select" data-grupo="${grupo}" data-pos="primeiro" ${bloqueado ? 'disabled' : ''}>
                  <option value="">Selecione...</option>
                  ${opts}
                </select>
              </div>
              <div class="form-group" style="flex:1;min-width:140px">
                <label class="form-label">2º Colocado</label>
                <select class="form-select" data-grupo="${grupo}" data-pos="segundo" ${bloqueado ? 'disabled' : ''}>
                  <option value="">Selecione...</option>
                  ${opts}
                </select>
              </div>
            </div>
            ${!bloqueado ? `<button class="btn btn-outline btn-sm mt-2" data-salvar-grupo="${grupo}">Salvar Grupo ${grupo}</button>` : ''}
          </div>
        </div>
      `
    }).join('')

    return `
      <section class="fase-section">
        <h2 class="fase-title">Classificação dos Grupos</h2>
        <p class="text-sm text-muted mb-4">Palpite de 1º e 2º colocado de cada grupo. Bloqueado em 11/06/2026 às 00:00 UTC.</p>
        ${grupoRows}
      </section>
    `
  }

  function renderSecaoTop4() {
    const bloqueado = top4Bloqueado()
    const selOpts = _selecoes.map(s =>
      `<option value="${s.id}">${s.nome} (${s.codigo})</option>`
    ).join('')

    const posicoes = [
      { key: 'campea_id',  label: 'Campeã',     pts: '10 pts' },
      { key: 'vice_id',    label: 'Vice-campeã', pts: '6 pts'  },
      { key: 'semi1_id',   label: '3º / 4º lugar', pts: '4 pts' },
      { key: 'semi2_id',   label: '3º / 4º lugar', pts: '4 pts' },
    ]

    const campos = posicoes.map(p => `
      <div class="form-group" style="flex:1;min-width:160px">
        <label class="form-label">${p.label} <span class="badge badge-blue">${p.pts}</span></label>
        <select class="form-select" id="top4-${p.key}" ${bloqueado ? 'disabled' : ''}>
          <option value="">Selecione...</option>
          ${selOpts}
        </select>
      </div>
    `).join('')

    return `
      <section class="fase-section">
        <h2 class="fase-title">Top 4 — Semifinalistas</h2>
        <p class="text-sm text-muted mb-4">Bloqueado no início das oitavas de final (~27/06/2026).</p>
        <div class="card">
          <div class="card-body">
            <div class="flex gap-4" style="flex-wrap:wrap">
              ${campos}
            </div>
            ${!bloqueado ? `<button class="btn btn-primary mt-4" id="btn-salvar-top4">Salvar Top 4</button>` : ''}
          </div>
        </div>
      </section>
    `
  }

  function initListeners() {
    const root = document.getElementById('app-root')

    // Palpites de jogo — salva com debounce
    const timers = {}
    root.addEventListener('input', e => {
      const input = e.target
      if (!input.matches('.palpite-input')) return
      const jogoId = parseInt(input.dataset.jogo)
      clearTimeout(timers[jogoId])
      timers[jogoId] = setTimeout(async () => {
        const casaEl = root.querySelector(`.palpite-input[data-jogo="${jogoId}"][data-side="casa"]`)
        const foraEl = root.querySelector(`.palpite-input[data-jogo="${jogoId}"][data-side="fora"]`)
        const casa = parseInt(casaEl?.value)
        const fora = parseInt(foraEl?.value)
        if (isNaN(casa) || isNaN(fora)) return
        try {
          await salvarPalpiteJogo(jogoId, casa, fora)
          App.toast('Palpite salvo!', 'success')
        } catch (err) {
          App.toast('Erro ao salvar palpite.', 'error')
        }
      }, 800)
    })

    // Grupos
    root.addEventListener('click', async e => {
      const btn = e.target.closest('[data-salvar-grupo]')
      if (!btn) return
      const grupo = btn.dataset.salvarGrupo
      const primeiroEl = root.querySelector(`select[data-grupo="${grupo}"][data-pos="primeiro"]`)
      const segundoEl  = root.querySelector(`select[data-grupo="${grupo}"][data-pos="segundo"]`)
      const primeiro = parseInt(primeiroEl?.value)
      const segundo  = parseInt(segundoEl?.value)
      if (!primeiro || !segundo) { App.toast('Selecione 1º e 2º colocados.', 'warning'); return }
      if (primeiro === segundo)   { App.toast('Selecione seleções diferentes.', 'warning'); return }
      try {
        btn.disabled = true
        await salvarPalpiteGrupo(grupo, primeiro, segundo)
        App.toast(`Grupo ${grupo} salvo!`, 'success')
      } catch (err) {
        App.toast('Erro ao salvar grupo.', 'error')
      } finally { btn.disabled = false }
    })

    // Top 4
    root.addEventListener('click', async e => {
      if (!e.target.matches('#btn-salvar-top4')) return
      const get = id => parseInt(document.getElementById(id)?.value) || null
      const campea = get('top4-campea_id')
      const vice   = get('top4-vice_id')
      const semi1  = get('top4-semi1_id')
      const semi2  = get('top4-semi2_id')
      if (!campea || !vice || !semi1 || !semi2) { App.toast('Preencha todos os campos do Top 4.', 'warning'); return }
      const ids = [campea, vice, semi1, semi2]
      if (new Set(ids).size !== 4) { App.toast('Selecione 4 seleções diferentes.', 'warning'); return }
      try {
        e.target.disabled = true
        await salvarTop4(campea, vice, semi1, semi2)
        App.toast('Top 4 salvo!', 'success')
      } catch (err) {
        App.toast('Erro ao salvar Top 4.', 'error')
      } finally { e.target.disabled = false }
    })
  }

  function populateStoredValues() {
    const root = document.getElementById('app-root')
    // Palpites de jogos
    // (carregados do Supabase via Jogos.load, que já os tem)
    // Grupos
    for (const [grupo, p] of Object.entries(_palpitesGrupos)) {
      const primeiroEl = root.querySelector(`select[data-grupo="${grupo}"][data-pos="primeiro"]`)
      const segundoEl  = root.querySelector(`select[data-grupo="${grupo}"][data-pos="segundo"]`)
      if (primeiroEl) primeiroEl.value = p.primeiro_id
      if (segundoEl)  segundoEl.value  = p.segundo_id
    }
    // Top 4
    if (_palpiteTop4) {
      const map = { campea_id: 'campea_id', vice_id: 'vice_id', semi1_id: 'semi1_id', semi2_id: 'semi2_id' }
      for (const [field, elId] of Object.entries(map)) {
        const el = document.getElementById(`top4-${elId}`)
        if (el && _palpiteTop4[field]) el.value = _palpiteTop4[field]
      }
    }
  }

  return { load, render, initListeners, populateStoredValues }
})()
