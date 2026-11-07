import type { AuthProfile, Connection } from './profileTypes'

export function ConnectionFields({ connection, onChange }: {
  connection: Connection
  onChange: (connection: Connection) => void
}) {
  return (
    <div className="profile-fields">
      <label>
        Name der Verbindung
        <input required maxLength={120} value={connection.name}
          onChange={(event) => onChange({ ...connection, name: event.target.value })} />
      </label>
      <label>
        Basis-URL
        <input required type="url" maxLength={2048} value={connection.baseUrl}
          onChange={(event) => onChange({ ...connection, baseUrl: event.target.value })} />
      </label>
    </div>
  )
}

export function AuthFields({ profile, onChange }: {
  profile: AuthProfile
  onChange: (profile: AuthProfile) => void
}) {
  return (
    <div className="profile-fields">
      <label>
        Name der Anmeldung
        <input required maxLength={120} value={profile.name}
          onChange={(event) => onChange({ ...profile, name: event.target.value })} />
      </label>
      <label>
        Anmeldeverfahren
        <select value={profile.type} onChange={(event) => onChange({
          ...profile,
          type: event.target.value as AuthProfile['type'],
          secretVariable: '',
        })}>
          <option value="basic">Basic</option>
          <option value="bearer">Bearer</option>
          <option value="merchant-jwt">Händler-JWT</option>
        </select>
      </label>
      {profile.type === 'basic' && (
        <label>
          Variable für den Benutzernamen
          <input required pattern="[A-Za-z_][A-Za-z0-9_]*" maxLength={120}
            value={profile.usernameVariable ?? ''}
            onChange={(event) => onChange({ ...profile, usernameVariable: event.target.value })} />
        </label>
      )}
      {profile.type === 'merchant-jwt' && (
        <>
          <label>
            Händler-ID
            <input required maxLength={120} value={profile.merchantId ?? ''}
              onChange={(event) => onChange({ ...profile, merchantId: event.target.value })} />
          </label>
          <label>
            Point-of-Use-ID
            <input required maxLength={120} value={profile.pointOfUseId ?? ''}
              onChange={(event) => onChange({ ...profile, pointOfUseId: event.target.value })} />
          </label>
        </>
      )}
      <label>
        {{ basic: 'Variable für das Passwort', bearer: 'Variable für den Token', 'merchant-jwt': 'Variable für den Signaturschlüssel' }[profile.type]}
        <input required pattern="[A-Za-z_][A-Za-z0-9_]*" maxLength={120} value={profile.secretVariable}
          onChange={(event) => onChange({ ...profile, secretVariable: event.target.value })} />
      </label>
    </div>
  )
}
