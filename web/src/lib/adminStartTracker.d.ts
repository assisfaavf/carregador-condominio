export type StartAttempt = {
  stationId: number
  userId: number
  existingSessionIds: number[]
  confirmed: boolean
}
export type StartSession = { session_id: number; station_id: number; user_id: number | null }
export type StartTelemetry = {
  success: boolean
  telemetry_unavailable?: boolean
  session_id?: number | null
  charging?: boolean
  workState?: string | null
  currentA?: number | null
  powerKw?: number | null
}
export class AdminStartTracker {
  readonly pending: boolean
  readonly tracking: boolean
  begin(request: Omit<StartAttempt, 'confirmed'>): StartAttempt | null
  confirm(attempt: StartAttempt): boolean
  confirmCharging(session: StartSession | null | undefined, live: StartTelemetry | null | undefined): boolean
  finish(attempt: StartAttempt): void
  reset(): void
}
