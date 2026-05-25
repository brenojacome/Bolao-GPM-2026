// Painel administrativo
const Admin = (() => {
  const GITHUB_OWNER = 'brenojacome'
  const GITHUB_REPO  = 'Bolao-GPM-2026'
  const WORKFLOW_ID  = 'sync-resultados.yml'

  let _syncLog = []
  let _jogosPendentes = []

  async function load() {
    const [{ data: logs }, { data: pendentes }] = await Promise.all([
      db.from('sync_log')
        .select('*, jogo:jogo_id(data_hora, selecao_casa:selecao_casa_id(nome), selecao_fora:selecao_fora_id(nome))')
        .order('executado_em', { ascending: false })
        .limit(50),
      db.from('jogos')
        .select('*, selecao_casa:selecao_casa_id(nome), selecao_fora:selecao_fora_id(nome)')
        .eq('resultado_confirmado', false)
        .lt('data_hora', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()),
    ])
    _syncLog = logs ?? []
    _jogosPendentes = pendentes ?? []
  }

  function render() {
    const ultimaSync = _syncLog[0]
    const syncInfo = ultimaSync
      ? `Última sync: ${new Date(ultimaSync.executado_em).toLocaleString('pt-BR')} — ${ultimaSync.status}`
      : 'Nenhuma sincronização registrada ainda.'

    const pendentesRows = _jogosPendentes.length
      ? _jogosPendentes.map(j => `
          <tr>
            <td>${j.selecao_casa?.nome ?? '?'} × ${j.selecao_fora?.nome ?? '?'}</td>
            <td>${new Date(j.data_hora).toLocaleString('pt-BR')}</td>
            <td>
              <button class="btn btn-sm btn-outline" data-corrigir="${j.id}">Corrigir</button>
            </td>
          </tr>
        `).join('')
      : '<tr><td colspan="3" class="text-center text-muted">Nenhum jogo pendente.</td></tr>'

    const logRows = _syncLog.slice(0, 20).map(l => {
      const badgeClass = l.status === 'ok' ? 'badge-green' : l.status === 'erro' ? 'badge-red' : 'badge-yellow'
      return `
        <tr>
          <td>${new Date(l.executado_em).toLocaleString('pt-BR')}</td>
          <td>${l.jogo ? `${l.jogo.selecao_casa?.nome ?? '?'} × ${l.jogo.selecao_fora?.nome ?? '?'}` : '—'}</td>
          <td><span class="badge ${badgeClass}">${l.status}</span></td>
          <td class="text-xs">${l.mensagem ?? ''}</td>
        </tr>
      `
    }).join('')

    return `
      <div class="view">
        <h1 class="view-title">Painel Admin</h1>

        <div class="admin-grid">
          <!-- Status da sync -->
          <div class="card">
            <div class="card-header">
              <span class="card-title">Sincronização</span>
            </div>
            <div class="card-body">
              <div class="sync-status-bar">
                <span class="text-sm">${syncInfo}</span>
              </div>
              <button class="btn btn-primary mt-4" id="btn-sync-agora">
                ⟳ Sincronizar agora
              </button>
              <p class="text-xs text-muted mt-2">Dispara o workflow no GitHub Actions via API.</p>
            </div>
          </div>

          <!-- Jogos pendentes -->
          <div class="card">
            <div class="card-header">
              <span class="card-title">Jogos aguardando confirmação</span>
              <span class="badge ${_jogosPendentes.length ? 'badge-red' : 'badge-green'}">${_jogosPendentes.length}</span>
            </div>
            <div class="card-body" style="padding:0">
              <table class="log-table">
                <thead><tr><th>Jogo</th><th>Data/hora</th><th>Ação</th></tr></thead>
                <tbody>${pendentesRows}</tbody>
              </table>
            </div>
          </div>

          <!-- Formulário de correção manual (oculto até clicar) -->
          <div id="form-correcao-wrap" class="card hidden">
            <div class="card-header">
              <span class="card-title">Corrigir resultado</span>
              <button class="btn btn-sm btn-ghost" id="btn-fechar-correcao" style="color:var(--color-text)">✕</button>
            </div>
            <div class="card-body">
              <input type="hidden" id="correcao-jogo-id" />
              <div class="flex gap-4" style="flex-wrap:wrap">
                <div class="form-group" style="flex:1">
                  <label class="form-label">Gols casa (90min)</label>
                  <input class="form-input" type="number" min="0" id="correcao-casa-90" />
                </div>
                <div class="form-group" style="flex:1">
                  <label class="form-label">Gols fora (90min)</label>
                  <input class="form-input" type="number" min="0" id="correcao-fora-90" />
                </div>
              </div>
              <div class="flex gap-4 mt-2" style="flex-wrap:wrap">
                <div class="form-group" style="flex:1">
                  <label class="form-label">Gols casa (final)</label>
                  <input class="form-input" type="number" min="0" id="correcao-casa-final" />
                </div>
                <div class="form-group" style="flex:1">
                  <label class="form-label">Gols fora (final)</label>
                  <input class="form-input" type="number" min="0" id="correcao-fora-final" />
                </div>
              </div>
              <div class="form-group mt-2">
                <label class="form-label">Houve prorrogação?</label>
                <select class="form-select" id="correcao-prorrogacao">
                  <option value="false">Não</option>
                  <option value="true">Sim</option>
                </select>
              </div>
              <div class="form-group mt-2">
                <label class="form-label">Houve pênaltis?</label>
                <select class="form-select" id="correcao-penaltis">
                  <option value="false">Não</option>
                  <option value="true">Sim</option>
                </select>
              </div>
              <button class="btn btn-primary mt-4 btn-full" id="btn-salvar-correcao">Salvar e recalcular</button>
            </div>
          </div>

          <!-- Log de sincronizações -->
          <div class="card">
            <div class="card-header">
              <span class="card-title">Log das últimas sincronizações</span>
            </div>
            <div class="card-body" style="padding:0;overflow-x:auto">
              <table class="log-table">
                <thead><tr><th>Horário</th><th>Jogo</th><th>Status</th><th>Mensagem</th></tr></thead>
                <tbody>${logRows || '<tr><td colspan="4" class="text-center text-muted">Sem registros.</td></tr>'}</tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `
  }

  async function disparaSyncWorkflow() {
    // Lê o PAT do perfil admin (salvo no Supabase via RLS)
    const { data: profile } = await db
      .from('profiles')
      .select('github_pat')
      .eq('id', Auth.getUser().id)
      .single()

    const pat = profile?.github_pat
    if (!pat) {
      App.toast('Configure o GitHub PAT no perfil admin primeiro.', 'error')
      return
    }

    const resp = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_ID}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    )

    if (resp.status === 204) {
      App.toast('Workflow disparado com sucesso!', 'success')
    } else {
      const txt = await resp.text()
      App.toast(`Erro ao disparar workflow: ${resp.status}`, 'error')
      console.error(txt)
    }
  }

  function initListeners() {
    const root = document.getElementById('app-root')

    root.addEventListener('click', async e => {
      if (e.target.matches('#btn-sync-agora')) {
        e.target.disabled = true
        e.target.textContent = 'Disparando...'
        try { await disparaSyncWorkflow() }
        finally { e.target.disabled = false; e.target.textContent = '⟳ Sincronizar agora' }
      }

      const btnCorrigir = e.target.closest('[data-corrigir]')
      if (btnCorrigir) {
        const jogoId = btnCorrigir.dataset.corrigir
        document.getElementById('correcao-jogo-id').value = jogoId
        document.getElementById('form-correcao-wrap').classList.remove('hidden')
        document.getElementById('form-correcao-wrap').scrollIntoView({ behavior: 'smooth' })
      }

      if (e.target.matches('#btn-fechar-correcao')) {
        document.getElementById('form-correcao-wrap').classList.add('hidden')
      }

      if (e.target.matches('#btn-salvar-correcao')) {
        await salvarCorrecao(e.target)
      }
    })
  }

  async function salvarCorrecao(btn) {
    const jogoId   = parseInt(document.getElementById('correcao-jogo-id').value)
    const casa90   = parseInt(document.getElementById('correcao-casa-90').value)
    const fora90   = parseInt(document.getElementById('correcao-fora-90').value)
    const casaFinal = parseInt(document.getElementById('correcao-casa-final').value)
    const foraFinal = parseInt(document.getElementById('correcao-fora-final').value)
    const prorrogacao = document.getElementById('correcao-prorrogacao').value === 'true'
    const penaltis    = document.getElementById('correcao-penaltis').value === 'true'

    if ([casa90, fora90, casaFinal, foraFinal].some(isNaN)) {
      App.toast('Preencha todos os placares.', 'warning')
      return
    }

    // Determinar vencedor
    let vencedorId = null
    const jogo = Jogos.getById(jogoId)
    if (casaFinal > foraFinal) vencedorId = jogo?.selecao_casa_id
    else if (foraFinal > casaFinal) vencedorId = jogo?.selecao_fora_id

    btn.disabled = true
    btn.textContent = 'Salvando...'

    try {
      const { error } = await db.from('jogos').update({
        gols_casa_90min: casa90,
        gols_fora_90min: fora90,
        gols_casa_final: casaFinal,
        gols_fora_final: foraFinal,
        teve_prorrogacao: prorrogacao,
        teve_penaltis: penaltis,
        vencedor_id: vencedorId,
        resultado_confirmado: true,
        ultima_sync: new Date().toISOString(),
      }).eq('id', jogoId)

      if (error) throw error

      const { error: rpcError } = await db.rpc('calcular_pontuacao', { p_jogo_id: jogoId })
      if (rpcError) throw rpcError

      App.toast('Resultado corrigido e pontuação recalculada!', 'success')
      document.getElementById('form-correcao-wrap').classList.add('hidden')
      await load()
      App.navigate('#admin')
    } catch (err) {
      App.toast('Erro ao salvar: ' + err.message, 'error')
    } finally {
      btn.disabled = false
      btn.textContent = 'Salvar e recalcular'
    }
  }

  return { load, render, initListeners }
})()
