// Inicialização, roteamento SPA e estado global
const App = (() => {
  const ROUTES = {
    '#login':    renderLogin,
    '#palpites': renderPalpites,
    '#jogos':    renderJogosView,
    '#ranking':  renderRanking,
    '#comparar': renderComparar,
    '#admin':    renderAdmin,
  }

  // ---------- Toast ----------
  function toast(msg, type = 'default') {
    let container = document.getElementById('toast-container')
    if (!container) {
      container = document.createElement('div')
      container.id = 'toast-container'
      document.body.appendChild(container)
    }
    const el = document.createElement('div')
    el.className = `toast ${type}`
    el.textContent = msg
    container.appendChild(el)
    setTimeout(() => el.remove(), 3500)
  }

  // ---------- Navegação ----------
  function navigate(hash) {
    if (hash) window.location.hash = hash
    route()
  }

  function route() {
    if (!Auth.isLoggedIn()) {
      renderLogin()
      return
    }

    const hash = window.location.hash || '#palpites'
    const fn = ROUTES[hash]
    if (fn) {
      fn()
    } else {
      renderPalpites()
    }

    // Atualiza nav ativa
    document.querySelectorAll('.nav-link').forEach(a => {
      a.classList.toggle('active', a.getAttribute('href') === hash)
    })

    // Mostra/oculta link admin
    document.querySelectorAll('.nav-admin').forEach(el => {
      el.classList.toggle('hidden', !Auth.isAdmin())
    })
  }

  // ---------- Views ----------
  function showLoading() {
    document.getElementById('app-root').innerHTML = `
      <div class="loading-screen">
        <div class="spinner"></div>
        <p>Carregando...</p>
      </div>
    `
  }

  async function renderLogin() {
    document.getElementById('app-header').classList.add('hidden')
    document.getElementById('app-root').innerHTML = renderLoginView()
    initLoginListeners()
  }

  async function renderPalpites() {
    showHeader()
    showLoading()
    await Promise.all([Jogos.load(), Palpites.load()])
    document.getElementById('app-root').innerHTML = Palpites.render()
    Palpites.initListeners()
    Palpites.populateStoredValues()
  }

  async function renderJogosView() {
    showHeader()
    showLoading()
    await Jogos.load()
    document.getElementById('app-root').innerHTML = Jogos.render()
  }

  async function renderRanking() {
    showHeader()
    showLoading()
    await Ranking.load()
    document.getElementById('app-root').innerHTML = Ranking.render()
    Ranking.subscribeRealtime()
  }

  async function renderComparar() {
    showHeader()
    showLoading()
    await Jogos.load()
    document.getElementById('app-root').innerHTML = renderCompararView()
    initCompararListeners()
  }

  async function renderAdmin() {
    if (!Auth.isAdmin()) { navigate('#palpites'); return }
    showHeader()
    showLoading()
    await Admin.load()
    document.getElementById('app-root').innerHTML = Admin.render()
    Admin.initListeners()
  }

  function showHeader() {
    document.getElementById('app-header').classList.remove('hidden')
  }

  // ---------- Comparar palpites ----------
  function renderCompararView() {
    const jogos = Jogos.getAll()
    const bloqueados = jogos.filter(j => new Date() >= new Date(j.prazo_palpite))

    const opts = bloqueados.map(j => {
      const casa = j.selecao_casa?.nome ?? 'A definir'
      const fora = j.selecao_fora?.nome ?? 'A definir'
      const dt = new Date(j.data_hora).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
      return `<option value="${j.id}">${dt} — ${casa} × ${fora}</option>`
    }).join('')

    return `
      <div class="view">
        <h1 class="view-title">Comparar Palpites</h1>
        <p class="text-sm text-muted mb-4">Disponível após o bloqueio de cada jogo.</p>
        <div class="form-group mb-4" style="max-width:400px">
          <label class="form-label">Selecione um jogo</label>
          <select class="form-select" id="comparar-select">
            <option value="">Escolha um jogo...</option>
            ${opts}
          </select>
        </div>
        <div id="comparar-resultado"></div>
      </div>
    `
  }

  function initCompararListeners() {
    document.getElementById('comparar-select')?.addEventListener('change', async e => {
      const jogoId = parseInt(e.target.value)
      if (!jogoId) return
      const container = document.getElementById('comparar-resultado')
      container.innerHTML = '<div class="loading-screen" style="min-height:120px"><div class="spinner"></div></div>'

      const [{ data: palpites }, { data: profiles }] = await Promise.all([
        db.from('palpites')
          .select('user_id, gols_casa, gols_fora')
          .eq('jogo_id', jogoId),
        db.from('profiles').select('id, nome'),
      ])

      const nomes = Object.fromEntries((profiles ?? []).map(p => [p.id, p.nome]))
      const jogo  = Jogos.getById(jogoId)
      const rows  = (palpites ?? []).map(p => {
        const isExato = jogo?.resultado_confirmado &&
          p.gols_casa === jogo.gols_casa_90min &&
          p.gols_fora === jogo.gols_fora_90min
        return `
          <tr>
            <td>${nomes[p.user_id] ?? 'Anônimo'}</td>
            <td class="text-center font-bold">${p.gols_casa} – ${p.gols_fora}</td>
            <td class="text-center">${isExato ? '<span class="badge badge-green">Exato!</span>' : ''}</td>
          </tr>
        `
      }).join('')

      if (!rows) {
        container.innerHTML = '<p class="text-muted">Nenhum palpite registrado para este jogo.</p>'
        return
      }

      container.innerHTML = `
        <div class="card">
          <div class="card-body" style="padding:0;overflow-x:auto">
            <table class="ranking-table">
              <thead><tr><th>Participante</th><th>Palpite</th><th></th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      `
    })
  }

  // ---------- Auth change callback ----------
  function onAuthChange(user, profile) {
    Ranking.unsubscribe?.()
    if (user) {
      const hash = window.location.hash
      navigate(hash && hash !== '#login' ? hash : '#palpites')
    } else {
      navigate('#login')
    }
  }

  // ---------- Bootstrap ----------
  async function init() {
    window.addEventListener('hashchange', () => {
      Ranking.unsubscribe()
      route()
    })

    await Auth.init()
    route()
  }

  return { init, navigate, toast, onAuthChange }
})()

// Iniciar app
document.addEventListener('DOMContentLoaded', () => App.init())
