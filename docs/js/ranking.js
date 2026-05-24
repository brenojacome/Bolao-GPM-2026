// Ranking geral — com Supabase Realtime
const Ranking = (() => {
  let _dados = []
  let _realtimeChannel = null
  let _currentUserId = null

  async function load() {
    _currentUserId = Auth.getUser().id

    const { data, error } = await db.rpc('get_ranking')
    if (error) {
      // fallback: montar ranking manualmente
      await loadManual()
      return
    }
    _dados = data ?? []
  }

  async function loadManual() {
    const { data: pontos } = await db
      .from('pontuacao')
      .select('user_id, pontos, categoria')

    const { data: profiles } = await db
      .from('profiles')
      .select('id, nome')

    const map = {}
    for (const p of (pontos ?? [])) {
      if (!map[p.user_id]) map[p.user_id] = { user_id: p.user_id, total: 0, exatos: 0, grupos: 0, top4: 0 }
      map[p.user_id].total += p.pontos
      if (p.categoria === 'jogo') map[p.user_id].exatos += (p.pontos === 3 ? 1 : 0)
      if (p.categoria === 'grupo') map[p.user_id].grupos += p.pontos
      if (p.categoria === 'top4') map[p.user_id].top4 += p.pontos
    }

    const nomes = Object.fromEntries((profiles ?? []).map(p => [p.id, p.nome]))
    _dados = Object.values(map)
      .map(r => ({ ...r, nome: nomes[r.user_id] ?? 'Participante' }))
      .sort((a, b) => b.total - a.total || b.exatos - a.exatos)
  }

  function subscribeRealtime() {
    if (_realtimeChannel) unsubscribe()
    _realtimeChannel = db
      .channel('ranking-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pontuacao' }, async () => {
        await load()
        const container = document.getElementById('ranking-container')
        if (container) container.innerHTML = renderTable()
      })
      .subscribe()
  }

  function unsubscribe() {
    if (_realtimeChannel) {
      db.removeChannel(_realtimeChannel)
      _realtimeChannel = null
    }
  }

  function render() {
    return `
      <div class="view">
        <h1 class="view-title">Ranking Geral</h1>
        <p class="text-sm text-muted mb-4">Atualizado automaticamente após cada resultado.</p>
        <div class="card">
          <div id="ranking-container">
            ${renderTable()}
          </div>
        </div>
      </div>
    `
  }

  function renderTable() {
    if (_dados.length === 0) {
      return `<div class="card-body text-center text-muted">Nenhum palpite registrado ainda.</div>`
    }

    const rows = _dados.map((p, i) => {
      const pos = i + 1
      let posClass = ''
      if (pos === 1) posClass = 'pos-1'
      else if (pos === 2) posClass = 'pos-2'
      else if (pos === 3) posClass = 'pos-3'

      const isMe = p.user_id === _currentUserId
      return `
        <tr class="${isMe ? 'ranking-me' : ''}">
          <td>
            <span class="ranking-pos ${posClass}">${pos}</span>
            &nbsp;<strong>${p.nome}</strong>${isMe ? ' <span class="badge badge-blue">você</span>' : ''}
          </td>
          <td><strong>${p.total ?? 0}</strong></td>
          <td>${p.exatos ?? 0}</td>
          <td>${p.grupos ?? 0}</td>
          <td>${p.top4 ?? 0}</td>
        </tr>
      `
    }).join('')

    return `
      <table class="ranking-table">
        <thead>
          <tr>
            <th>Participante</th>
            <th>Total</th>
            <th>Exatos</th>
            <th>Grupos</th>
            <th>Top 4</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `
  }

  return { load, render, subscribeRealtime, unsubscribe }
})()
