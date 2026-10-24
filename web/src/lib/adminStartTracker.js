// Keep the request identity outside React's asynchronous state updates.
export class AdminStartTracker {
  current = null
  inFlight = false

  get pending() { return this.inFlight }
  get tracking() { return this.current !== null }

  begin(request) {
    if (this.pending) return null
    this.current = { ...request, existingSessionIds: [...request.existingSessionIds], confirmed: false }
    this.inFlight = true
    return this.current
  }

  confirm(attempt) {
    if (this.current !== attempt || attempt.confirmed) return false
    attempt.confirmed = true
    return true
  }

  confirmCharging(session, live) {
    const attempt = this.current
    if (!attempt || !session || !live || live.success !== true || live.telemetry_unavailable) return false
    const matches = String(session.station_id) === String(attempt.stationId)
      && String(session.user_id) === String(attempt.userId)
      && !attempt.existingSessionIds.some((id) => String(id) === String(session.session_id))
      && live.session_id != null && String(live.session_id) === String(session.session_id)
    const charging = live.charging === true || live.workState === 'charger_charging'
    const flow = Number(live.currentA) >= 2 || Number(live.powerKw) >= 0.5
    return matches && charging && flow ? this.confirm(attempt) : false
  }

  finish(attempt) {
    if (this.current !== attempt) return
    this.inFlight = false
    // Retain an uncertain request so a later successful poll can still close it.
    if (attempt.confirmed) this.current = null
  }

  reset() {
    if (!this.pending) this.current = null
  }
}
