import { readFileSync } from 'node:fs'
import { maxPasswordLength } from './accounts.mjs'

const themeStyles = readFileSync(new URL('./themes.css', import.meta.url), 'utf8')

const translations = {
  'Set up two-factor authentication': 'Zwei-Faktor-Authentifizierung einrichten',
  'Enter your sign-in code': 'Anmeldecode eingeben', 'Sign in': 'Anmelden',
  'Scan this QR code with your authenticator app, then enter the six-digit code it shows.': 'Diesen QR-Code mit der Authenticator-App scannen und anschließend den angezeigten sechsstelligen Code eingeben.',
  'Enter the current six-digit code from your authenticator app.': 'Den aktuellen sechsstelligen Code aus der Authenticator-App eingeben.',
  'Enter your workspace credentials to continue.': 'Zum Fortfahren die Zugangsdaten für den Arbeitsbereich eingeben.',
  'Use the sign-in form.': 'Das Anmeldeformular verwenden.', 'The sign-in form is too large.': 'Das Anmeldeformular ist zu groß.',
  'Invalid username or password.': 'Benutzername oder Passwort ungültig.',
  'Too many sign-in attempts. Try again later.': 'Zu viele Anmeldeversuche. Später erneut versuchen.',
  'Too many code attempts. Try again later.': 'Zu viele Codeversuche. Später erneut versuchen.',
  'Invalid or expired code.': 'Code ungültig oder abgelaufen.',
  'Self-hosted workspace': 'Selbst gehosteter Arbeitsbereich', 'A workspace for API testing': 'Ein Arbeitsbereich für API-Tests',
  'Build HTTP requests, inspect responses, and import or export Postman collections.': 'HTTP-Anfragen erstellen, Antworten untersuchen und Postman-Sammlungen importieren oder exportieren.',
  'Example request': 'Beispielanfrage', 'Authenticator setup QR code': 'QR-Code zur Einrichtung der Authenticator-App',
  'Six-digit code': 'Sechsstelliger Code', 'Verify code': 'Code prüfen', 'Start over': 'Erneut beginnen',
  'Lost access? Contact your workspace administrator.': 'Zugriff verloren? An die Administration des Arbeitsbereichs wenden.',
  'Username': 'Benutzername', 'Password': 'Passwort', 'Need access? Contact your workspace administrator.': 'Zugang benötigt? An die Administration des Arbeitsbereichs wenden.',
  'Language': 'Sprache', 'Change language': 'Sprache ändern',
}

export function renderLoginPage(message, challenge, language = 'en', next = '') {
  const t = text => language === 'de' ? (translations[text] ?? text) : text
  const heading = challenge?.qrCode ? 'Set up two-factor authentication' : challenge ? 'Enter your sign-in code' : 'Sign in'
  const description = challenge?.qrCode
    ? 'Scan this QR code with your authenticator app, then enter the six-digit code it shows.'
    : challenge ? 'Enter the current six-digit code from your authenticator app.' : 'Enter your workspace credentials to continue.'
  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${t('Sign in')} | API Protocol Test Suite</title>
  <link rel="icon" type="image/png" sizes="64x64" href="/favicon.png">
  <style>
    ${themeStyles}
    :root {
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font: 100%/1.5 var(--vscode-font-family);
      --muted: var(--vscode-descriptionForeground);
      --accent: var(--vscode-button-background);
      --mono: var(--mono-font);
    }

    * { box-sizing: border-box; }
    body {
      display: grid;
      place-items: center;
      min-height: 100vh;
      min-height: 100dvh;
      margin: 0;
      padding: clamp(1rem, 4vw, 4rem);
      background: radial-gradient(ellipse at 30% 0%, var(--surface-inset), transparent 65%);
    }

    .login {
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
      width: min(100%, 70rem);
      overflow: hidden;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 1.25rem;
      background: var(--vscode-panel-background);
      box-shadow: 0 1.5rem 5rem #0006;
    }

    .overview {
      position: relative;
      isolation: isolate;
      min-width: 0;
      overflow-wrap: anywhere;
      padding: clamp(2rem, 4.5vw, 4rem);
      border-inline-end: 1px solid var(--vscode-panel-border);
      background: radial-gradient(ellipse at 100% 0%, var(--surface-inset), transparent 70%), var(--vscode-sideBar-background);
    }

    .overview::before {
      position: absolute;
      z-index: -1;
      inset: 0;
      background-image: radial-gradient(circle, #0078d450 1px, transparent 1px);
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
      border: 1px solid var(--vscode-focusBorder);
      border-radius: .625rem;
      color: var(--vscode-foreground);
      background: var(--surface-inset);
    }

    .intro { margin-top: clamp(2.75rem, 5vw, 4.5rem); }
    .eyebrow {
      margin: 0 0 .875rem;
      color: var(--vscode-foreground);
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

    .summary { max-width: 32ch; margin: 1rem 0 0; color: var(--vscode-foreground); }

    .example {
      max-width: 27rem;
      margin: 2.25rem 0 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: .75rem;
      background: var(--vscode-editor-background);
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
      border-bottom: 1px solid var(--vscode-panel-border);
      color: var(--vscode-foreground);
      font-size: .6875rem;
      letter-spacing: .08em;
      text-transform: uppercase;
    }

    .exchange { padding-block: 1rem; }
    .method, .status { padding: .1875rem .4375rem; border-radius: .25rem; white-space: nowrap; }
    .method { color: var(--vscode-foreground); background: var(--surface-inset); }
    .status { margin-inline-start: auto; color: #a6dec4; background: #23362f; }

    .sign-in {
      align-self: center;
      min-width: 0;
      overflow-wrap: anywhere;
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
    form { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1.125rem; margin-top: 1.75rem; }
    label { display: grid; gap: .4375rem; font-size: .875rem; font-weight: 600; }

    input, select, button {
      width: 100%;
      min-width: 0;
      min-height: 3rem;
      padding: .625rem .875rem;
      border: 1px solid;
      border-radius: .5rem;
      font: inherit;
    }

    input, select {
      border-color: var(--vscode-descriptionForeground);
      color: inherit;
      background: var(--surface-inset);
      font-size: 1rem;
      font-weight: 400;
    }

    input:hover { border-color: var(--vscode-foreground); }
    input:focus { border-color: var(--accent); outline: 1px solid var(--accent); }
    .qr-code { display: block; width: min(100%, 14rem); height: auto; margin-top: 1.25rem; image-rendering: pixelated; }
    .help a { color: inherit; }

    button {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: .625rem;
      margin-top: .25rem;
      border-color: transparent;
      color: var(--vscode-button-foreground);
      background: var(--accent);
      font-weight: 700;
      cursor: pointer;
    }

    button:hover { background: var(--vscode-button-hoverBackground); }
    button:active { background: var(--vscode-button-background); }
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
      border-top: 1px solid var(--vscode-panel-border);
      color: var(--muted);
      font-size: .8125rem;
    }

    @media (max-width: 48rem) {
      .login { grid-template-columns: minmax(0, 1fr); max-width: 30rem; }
      .overview { padding: 1.25rem clamp(1.25rem, 6vw, 2.5rem); border-inline-end: 0; border-bottom: 1px solid var(--vscode-panel-border); }
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
        <p class="eyebrow">${t('Self-hosted workspace')}</p>
        <p class="headline">${t('A workspace for API testing')}</p>
        <p class="summary">${t('Build HTTP requests, inspect responses, and import or export Postman collections.')}</p>
      </div>
      <figure class="example">
        <figcaption class="example-caption"><span>${t('Example request')}</span><span>HTTP/1.1</span></figcaption>
        <div class="exchange">
          <span class="method">GET</span>
          <code>/api/health</code>
          <span class="status">200 OK</span>
        </div>
      </figure>
    </div>
    <section class="sign-in" aria-labelledby="sign-in-title">
      <form method="get" class="language-form">
        ${next ? `<input type="hidden" name="next" value="${next.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}">` : ''}
        <label>${t('Language')} <select name="language"><option value="de"${language === 'de' ? ' selected' : ''}>Deutsch</option><option value="en"${language === 'en' ? ' selected' : ''}>English</option></select></label>
        <button type="submit">${t('Change language')}</button>
      </form>
      <h1 id="sign-in-title">${t(heading)}</h1>
      <p class="description">${t(description)}</p>
      ${message ? `<p class="alert" role="alert">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" focusable="false">
          <circle cx="8" cy="8" r="6.25"/><path d="M8 4.75v3.5m0 2.5h.01"/>
        </svg>
        ${t(message)}
      </p>` : ''}
      ${challenge?.qrCode ? `<img class="qr-code" src="${challenge.qrCode}" alt="${t('Authenticator setup QR code')}">` : ''}
      ${challenge ? `<form method="post" action="/login/totp">
        <label>${t('Six-digit code')}
          <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus>
        </label>
        <button type="submit">${t('Verify code')}</button>
      </form>
      <p class="help"><a href="/login">${t('Start over')}</a> · ${t('Lost access? Contact your workspace administrator.')}</p>` : `<form method="post">
        <label>${t('Username')}
          <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required autofocus>
        </label>
        <label>${t('Password')}
          <input name="password" type="password" autocomplete="current-password" maxlength="${maxPasswordLength}" required>
        </label>
        <button type="submit">
          ${t('Sign in')}
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" focusable="false">
            <path d="M4 12h15m-6-6 6 6-6 6"/>
          </svg>
        </button>
      </form>
      <p class="help">${t('Need access? Contact your workspace administrator.')}</p>`}
    </section>
  </main>
</body>
</html>`
}
