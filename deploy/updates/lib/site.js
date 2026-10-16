const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
    return entities[character]
  })

export function renderHome({ stable, preview }) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#101827">
  <title>Cudia — baixar e atualizar</title>
  <style>
    :root{color-scheme:dark;--bg:#101827;--panel:#172235;--line:#2a3950;--text:#edf3fb;--muted:#a8b6c9;--accent:#73e0bd;--blue:#8eb7ff}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at top,#1c3042 0,#101827 48rem);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
    a{color:inherit}.wrap{width:min(1060px,calc(100% - 40px));margin:auto}.top{padding:26px 0;border-bottom:1px solid #ffffff18}.brand{font-weight:750;letter-spacing:.08em;text-decoration:none}.brand span{color:var(--accent)}
    main{padding:68px 0 44px}.eyebrow{color:var(--accent);font-size:.8rem;font-weight:700;letter-spacing:.15em;text-transform:uppercase}h1{max-width:780px;margin:.65rem 0 1rem;font-size:clamp(2.4rem,6vw,4.5rem);line-height:1.04;letter-spacing:-.045em}h2{font-size:1.35rem;line-height:1.2;margin:0 0 1rem}p{color:var(--muted);margin:.5rem 0 0}.intro{max-width:690px;font-size:1.1rem}
    .releases{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,330px),1fr));gap:18px;margin:40px 0}.card{background:linear-gradient(145deg,#1a2940,#151f30);border:1px solid var(--line);border-radius:18px;padding:25px;box-shadow:0 20px 60px #0002}.channel{color:var(--blue);font-size:.8rem;font-weight:750;letter-spacing:.1em;text-transform:uppercase}.channel.preview{color:#ffd07b}.version{font-size:1.8rem;font-weight:750;margin:.45rem 0 0}.meta{font-size:.9rem;margin-top:.7rem}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:23px}.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 15px;border-radius:10px;background:var(--accent);color:#10231f;font-weight:750;text-decoration:none}.button.secondary{background:#23344b;color:var(--text);border:1px solid #40536d}.unavailable{padding:12px 0 0;font-size:.9rem;color:#ffd07b}.section{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:22px;padding:25px 0 42px;border-top:1px solid #ffffff18}.section h2{font-size:1rem}.section p{font-size:.93rem}.foot{padding:20px 0 36px;border-top:1px solid #ffffff18;color:var(--muted);font-size:.85rem}.foot a{color:var(--blue)}
    .version{overflow-wrap:anywhere}.command{display:block;margin-top:14px;padding:12px 14px;background:#101827;border:1px solid var(--line);border-radius:8px;color:var(--text);font:1rem ui-monospace,monospace}
    @media(max-width:560px){main{padding-top:46px}.wrap{width:min(100% - 28px,1060px)}.card{padding:20px}}
  </style>
</head>
<body>
  <header class="top"><div class="wrap"><a class="brand" href="/" aria-label="Cudia início">CUDIA<span> /</span> WINDOWS</a></div></header>
  <main class="wrap">
    <div class="eyebrow">Downloads oficiais</div>
    <h1>Instale o Cudia. Atualize no seu ritmo.</h1>
    <p class="intro">Baixe o Cudia para Windows x64. Os pacotes são verificados por um manifesto assinado; cada canal mostra a versão e os arquivos disponíveis.</p>
    <div class="releases">${releaseCard("stable", stable)}${releaseCard("preview", preview)}</div>
    <section class="section" aria-label="Informações da versão">
      <div><h2>Requisitos</h2><p>Windows x64 e conexão com a internet para baixar ou atualizar. O Cudia inclui seu próprio runtime; não é necessário instalar Node.js, Bun ou Git.</p></div>
      <div><h2>Já tem o Cudia?</h2><p>Execute este comando em um terminal para baixar, verificar e selecionar a versão publicada. Sessões abertas continuam na versão anterior até você reabrir.</p><code class="command">cudia update</code></div>
      <div><h2>Atualizações verificadas</h2><p>Os arquivos são selecionados a partir de metadados assinados e válidos. O instalador e o atualizador verificam a autenticidade antes de aplicar uma versão.</p></div>
    </section>
  </main>
  <footer class="foot"><div class="wrap">Cudia para Windows · <a href="/updates/v1/stable.json">Manifesto estável</a> · <a href="/updates/v1/preview.json">Manifesto preview</a></div></footer>
</body>
</html>`
}

function releaseCard(channel, payload) {
  const label = channel === "stable" ? "Estável" : "Preview"
  if (!payload) {
    const message = channel === "stable" ? "Nenhuma versão estável está publicada no momento." : "Não foi possível validar uma versão preview agora."
    return `<article class="card"><div class="channel ${channel}">${label}</div><h2>Indisponível</h2><p>${message}</p></article>`
  }

  const artifacts = payload.artifacts
  const available = (kind, variant) => artifacts.some((item) => item.kind === kind && item.variant === variant)
  const installers = ["normal", "baseline"].filter((variant) => available("installer", variant))
  const links = [
    ...(installers.length
      ? installers.map((variant) => `<a class="button" href="/download/windows?channel=${channel}&amp;variant=${variant}&amp;kind=installer">Baixar instalador${variant === "baseline" ? " · CPUs antigas" : ""}</a>`)
      : [`<span class="unavailable">Instalador ainda não publicado neste canal.</span>`]),
    ...["normal", "baseline"].filter((variant) => available("archive", variant)).map((variant) =>
      `<a class="button secondary" href="/download/windows?channel=${channel}&amp;variant=${variant}&amp;kind=archive">Pacote ZIP${variant === "baseline" ? " · CPUs antigas" : ""}</a>`,
    ),
  ].join("")

  return `<article class="card">
    <div class="channel ${channel}">${label}</div>
    <div class="version">Runtime ${escapeHtml(payload.version)}</div>
    <p class="meta">Sequência ${escapeHtml(payload.sequence)} · Windows x64</p>
    <p class="meta">Publicado em ${escapeHtml(payload.issuedAt)} · válido até ${escapeHtml(payload.expiresAt)}</p>
    <div class="actions">${links}</div>
  </article>`
}
