// Autenticação — login, cadastro, sessão
const Auth = (() => {
  let currentUser = null
  let currentProfile = null

  async function init() {
    const { data: { session } } = await db.auth.getSession()
    if (session?.user) {
      currentUser = session.user
      await loadProfile()
    }

    db.auth.onAuthStateChange(async (_event, session) => {
      currentUser = session?.user ?? null
      currentProfile = null
      if (currentUser) await loadProfile()
      App.onAuthChange(currentUser, currentProfile)
    })
  }

  async function loadProfile() {
    const { data } = await db
      .from('profiles')
      .select('*')
      .eq('id', currentUser.id)
      .single()
    currentProfile = data
  }

  async function signIn(email, password) {
    const { data, error } = await db.auth.signInWithPassword({ email, password })
    if (error) throw error
    return data
  }

  async function signUp(email, password, nome) {
    const { data, error } = await db.auth.signUp({
      email,
      password,
      options: { data: { nome } },
    })
    if (error) throw error

    if (data.user) {
      await db.from('profiles').upsert({
        id: data.user.id,
        nome,
        is_admin: false,
      })
    }
    return data
  }

  async function signOut() {
    await db.auth.signOut()
  }

  function getUser()    { return currentUser }
  function getProfile() { return currentProfile }
  function isAdmin()    { return currentProfile?.is_admin === true }
  function isLoggedIn() { return currentUser !== null }

  return { init, signIn, signUp, signOut, getUser, getProfile, isAdmin, isLoggedIn }
})()

// ---------- Renderização da tela de login ----------
function renderLoginView() {
  return `
    <div class="login-page">
      <div class="login-card">
        <div class="login-logo">
          <span class="emoji">⚽</span>
          <h1>Bolão Copa 2026</h1>
          <p>EUA · México · Canadá</p>
        </div>

        <div class="login-tabs">
          <button class="login-tab active" data-tab="login">Entrar</button>
          <button class="login-tab" data-tab="cadastro">Cadastrar</button>
        </div>

        <div id="login-error" class="login-error hidden"></div>

        <form id="form-login" class="login-form">
          <div class="form-group">
            <label class="form-label" for="login-email">E-mail</label>
            <input class="form-input" id="login-email" type="email" required placeholder="seu@email.com" autocomplete="email" />
          </div>
          <div class="form-group">
            <label class="form-label" for="login-password">Senha</label>
            <input class="form-input" id="login-password" type="password" required placeholder="••••••••" autocomplete="current-password" />
          </div>
          <button type="submit" class="btn btn-primary btn-full" id="btn-login-submit">Entrar</button>
        </form>

        <form id="form-cadastro" class="login-form hidden">
          <div class="form-group">
            <label class="form-label" for="cadastro-nome">Seu nome</label>
            <input class="form-input" id="cadastro-nome" type="text" required placeholder="Como você quer aparecer no ranking" />
          </div>
          <div class="form-group">
            <label class="form-label" for="cadastro-email">E-mail</label>
            <input class="form-input" id="cadastro-email" type="email" required placeholder="seu@email.com" autocomplete="email" />
          </div>
          <div class="form-group">
            <label class="form-label" for="cadastro-password">Senha</label>
            <input class="form-input" id="cadastro-password" type="password" required placeholder="Mínimo 6 caracteres" autocomplete="new-password" minlength="6" />
          </div>
          <button type="submit" class="btn btn-primary btn-full" id="btn-cadastro-submit">Criar conta</button>
        </form>
      </div>
    </div>
  `
}

function initLoginListeners() {
  // Trocar tabs
  document.querySelectorAll('.login-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.login-tab').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      const which = tab.dataset.tab
      document.getElementById('form-login').classList.toggle('hidden', which !== 'login')
      document.getElementById('form-cadastro').classList.toggle('hidden', which !== 'cadastro')
      document.getElementById('login-error').classList.add('hidden')
    })
  })

  // Login
  document.getElementById('form-login').addEventListener('submit', async e => {
    e.preventDefault()
    const btn = document.getElementById('btn-login-submit')
    const errorEl = document.getElementById('login-error')
    btn.disabled = true
    btn.textContent = 'Entrando...'
    errorEl.classList.add('hidden')
    try {
      await Auth.signIn(
        document.getElementById('login-email').value.trim(),
        document.getElementById('login-password').value
      )
    } catch (err) {
      errorEl.textContent = 'E-mail ou senha incorretos.'
      errorEl.classList.remove('hidden')
    } finally {
      btn.disabled = false
      btn.textContent = 'Entrar'
    }
  })

  // Cadastro
  document.getElementById('form-cadastro').addEventListener('submit', async e => {
    e.preventDefault()
    const btn = document.getElementById('btn-cadastro-submit')
    const errorEl = document.getElementById('login-error')
    btn.disabled = true
    btn.textContent = 'Criando conta...'
    errorEl.classList.add('hidden')
    try {
      await Auth.signUp(
        document.getElementById('cadastro-email').value.trim(),
        document.getElementById('cadastro-password').value,
        document.getElementById('cadastro-nome').value.trim()
      )
      errorEl.style.background = '#dcfce7'
      errorEl.style.color = '#166534'
      errorEl.textContent = 'Conta criada! Verifique seu e-mail para confirmar o cadastro.'
      errorEl.classList.remove('hidden')
    } catch (err) {
      errorEl.style.background = ''
      errorEl.style.color = ''
      errorEl.textContent = err.message || 'Erro ao criar conta.'
      errorEl.classList.remove('hidden')
    } finally {
      btn.disabled = false
      btn.textContent = 'Criar conta'
    }
  })
}
