import { maxPasswordLength } from './accounts.mjs'

export function renderLoginPage(message) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in | API Protocol Test Suite</title>
  <link rel="icon" type="image/png" sizes="64x64" href="/favicon.png">
  <style>
    :root {
      color-scheme: dark;
      color: #f5f4f6;
      background: #111114;
      font: 100%/1.5 "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
      --muted: #adaab3;
      --accent: #ff885f;
      --mono: "Cascadia Code", Consolas, monospace;
    }

    * { box-sizing: border-box; }
    body {
      display: grid;
      place-items: center;
      min-height: 100vh;
      min-height: 100dvh;
      margin: 0;
      padding: clamp(1rem, 4vw, 4rem);
      background: radial-gradient(ellipse at 30% 0%, #212026, transparent 65%);
    }

    .login {
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
      width: min(100%, 70rem);
      overflow: hidden;
      border: 1px solid #39363e;
      border-radius: 1.25rem;
      background: #1c1b20;
      box-shadow: 0 1.5rem 5rem #0006;
    }

    .overview {
      position: relative;
      isolation: isolate;
      padding: clamp(2rem, 4.5vw, 4rem);
      border-inline-end: 1px solid #39363e;
      background: radial-gradient(ellipse at 100% 0%, #372724, transparent 70%), #222026;
    }

    .overview::before {
      position: absolute;
      z-index: -1;
      inset: 0;
      background-image: radial-gradient(circle, #ffad8d50 1px, transparent 1px);
      background-size: 1.25rem 1.25rem;
      mask-image: radial-gradient(ellipse at 100% 0%, #000, transparent 65%);
      content: "";
    }

    .brand {
      display: flex;
      align-items: center;
      gap: .75rem;
      margin: 0;
      font-size: .9375rem;
      font-weight: 650;
    }

    .brand-mark {
      display: grid;
      flex: 0 0 auto;
      place-items: center;
      width: 2.625rem;
      aspect-ratio: 1;
      border: 1px solid #9a5b48;
      border-radius: .625rem;
      color: #ffa582;
      background: #482e2b;
    }

    .intro { margin-top: clamp(2.75rem, 5vw, 4.5rem); }
    .eyebrow {
      margin: 0 0 .875rem;
      color: #ffa582;
      font: .75rem/1.5 var(--mono);
      letter-spacing: .12em;
      text-transform: uppercase;
    }

    .headline {
      max-width: 13ch;
      margin: 0;
      font-size: clamp(2.5rem, 4.1vw, 3.625rem);
      font-weight: 650;
      line-height: 1.05;
      letter-spacing: -.045em;
      text-wrap: balance;
    }

    .summary { max-width: 32ch; margin: 1rem 0 0; color: #c4c0c8; }

    .example {
      max-width: 27rem;
      margin: 2.25rem 0 0;
      border: 1px solid #45414b;
      border-radius: .75rem;
      background: #1a191e;
      font: .8125rem/1.5 var(--mono);
    }

    .example-caption, .exchange {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: .625rem;
      padding: .75rem 1rem;
    }

    .example-caption {
      justify-content: space-between;
      border-bottom: 1px solid #3a363f;
      color: #cbc7d0;
      font-size: .6875rem;
      letter-spacing: .08em;
      text-transform: uppercase;
    }

    .exchange { padding-block: 1rem; }
    .method, .status { padding: .1875rem .4375rem; border-radius: .25rem; white-space: nowrap; }
    .method { color: #ffb298; background: #3e2b29; }
    .status { margin-inline-start: auto; color: #a6dec4; background: #23362f; }

    .sign-in {
      align-self: center;
      width: 100%;
      max-width: 33rem;
      margin-inline: auto;
      padding: clamp(2rem, 4.5vw, 4rem);
    }

    h1 {
      margin: 0;
      font-size: clamp(2rem, 3vw, 2.625rem);
      font-weight: 650;
      line-height: 1.12;
      letter-spacing: -.035em;
    }

    .description { margin: .625rem 0 0; color: var(--muted); }
    form { display: grid; gap: 1.125rem; margin-top: 1.75rem; }
    label { display: grid; gap: .4375rem; font-size: .875rem; font-weight: 600; }

    input, button {
      width: 100%;
      min-width: 0;
      min-height: 3rem;
      padding: .625rem .875rem;
      border: 1px solid;
      border-radius: .5rem;
      font: inherit;
    }

    input {
      border-color: #76717e;
      color: inherit;
      background: #151418;
      font-size: 1rem;
      font-weight: 400;
    }

    input:hover { border-color: #a19aa9; }
    input:focus { border-color: var(--accent); outline: 1px solid var(--accent); }

    button {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: .625rem;
      margin-top: .25rem;
      border-color: transparent;
      color: #211511;
      background: var(--accent);
      font-weight: 700;
      cursor: pointer;
    }

    button:hover { background: #ffa182; }
    button:active { background: #f5764c; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }

    .alert {
      display: flex;
      align-items: flex-start;
      gap: .625rem;
      margin: 1.25rem 0 0;
      padding: .6875rem .8125rem;
      border: 1px solid #85505a;
      border-radius: .5rem;
      color: #ffc3c8;
      background: #3a232a;
      font-size: .875rem;
    }

    .alert svg { flex: 0 0 auto; margin-top: .125rem; }

    .help {
      margin: 1.75rem 0 0;
      padding-top: 1.125rem;
      border-top: 1px solid #39363e;
      color: var(--muted);
      font-size: .8125rem;
    }

    @media (max-width: 48rem) {
      .login { grid-template-columns: minmax(0, 1fr); max-width: 30rem; }
      .overview { padding: 1.25rem clamp(1.25rem, 6vw, 2.5rem); border-inline-end: 0; border-bottom: 1px solid #39363e; }
      .intro, .example { display: none; }
      .sign-in { padding: 2rem clamp(1.25rem, 6vw, 2.5rem); }
    }
  </style>
</head>
<body>
  <main class="login">
    <div class="overview">
      <p class="brand">
        <span class="brand-mark" aria-hidden="true">
          <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" focusable="false">
            <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-2-12-4 14"/>
          </svg>
        </span>
        API Protocol Test Suite
      </p>
      <div class="intro">
        <p class="eyebrow">Self-hosted workspace</p>
        <p class="headline">A workspace for API testing</p>
        <p class="summary">Build HTTP requests, inspect responses, and import or export Postman collections.</p>
      </div>
      <figure class="example">
        <figcaption class="example-caption"><span>Example request</span><span>HTTP/1.1</span></figcaption>
        <div class="exchange">
          <span class="method">GET</span>
          <code>/api/health</code>
          <span class="status">200 OK</span>
        </div>
      </figure>
    </div>
    <section class="sign-in" aria-labelledby="sign-in-title">
      <h1 id="sign-in-title">Sign in</h1>
      <p class="description">Enter your workspace credentials to continue.</p>
      ${message ? `<p class="alert" role="alert">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" focusable="false">
          <circle cx="8" cy="8" r="6.25"/><path d="M8 4.75v3.5m0 2.5h.01"/>
        </svg>
        ${message}
      </p>` : ''}
      <form method="post">
        <label>Username
          <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required autofocus>
        </label>
        <label>Password
          <input name="password" type="password" autocomplete="current-password" maxlength="${maxPasswordLength}" required>
        </label>
        <button type="submit">
          Sign in
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" focusable="false">
            <path d="M4 12h15m-6-6 6 6-6 6"/>
          </svg>
        </button>
      </form>
      <p class="help">Need access? Contact your workspace administrator.</p>
    </section>
  </main>
</body>
</html>`
}
