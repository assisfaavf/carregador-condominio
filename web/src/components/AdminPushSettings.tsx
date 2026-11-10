import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { apiFetch } from '../api/client'

type PushStatus = { configured: boolean; publicKey: string; enabled: boolean }
export default function AdminPushSettings() {
  const { user } = useAuth()
  const [status, setStatus] = useState<PushStatus | null>(null)
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const installed = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
  useEffect(() => {
    if (!user?.is_admin || !supported) return
    let cancelled = false
    void (async () => {
      const settings = await apiFetch<PushStatus>('/api/admin/push')
      const worker = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      await navigator.serviceWorker.ready
      const subscription = await worker.pushManager.getSubscription()
      if (!cancelled) { setStatus(settings); setRegistration(worker); setEnabled(settings.enabled && subscription != null) }
    })().catch(() => { if (!cancelled) setMessage('Não foi possível consultar as notificações. Atualize a página para tentar novamente.') })
    return () => { cancelled = true }
  }, [supported, user?.is_admin])
  if (!user?.is_admin) return null

  async function enable() {
    if (!registration || !status?.configured) return
    setBusy(true); setMessage('')
    try {
      // The permission request is the first async action of this explicit click.
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') { setMessage('Permissão não concedida. Confira os ajustes de notificações deste app no iPhone.'); return }
      const base64 = status.publicKey.replace(/-/g, '+').replace(/_/g, '/')
      const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
      const key = Uint8Array.from(binary, (character) => character.charCodeAt(0))
      const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
      await apiFetch('/api/admin/push', { method: 'POST', body: { subscription: subscription.toJSON() } })
      setEnabled(true); setMessage('Notificações ativadas neste aparelho para a sessão atual.')
    } catch { setMessage('Não foi possível ativar as notificações. Confira a permissão e a conexão e tente novamente.') }
    finally { setBusy(false) }
  }
  async function disable() {
    setBusy(true); setMessage('')
    try {
      await apiFetch('/api/admin/push', { method: 'DELETE' })
      setEnabled(false)
      try { await (await registration?.pushManager.getSubscription())?.unsubscribe() } catch { /* Server already disabled sends. */ }
      setMessage('Notificações desativadas neste aparelho.')
    } catch { setMessage('Não foi possível desativar no servidor. Tente novamente.') }
    finally { setBusy(false) }
  }
  return <section className="rounded-2xl border border-white/15 bg-surface-dark p-5 text-white">
    <h2 className="text-lg font-bold">Notificações do administrador</h2>
    <p className="mt-2 text-sm text-slate-300">Receba avisos de carro conectado, recarga iniciada e recarga finalizada com consumo confirmado, mesmo com o app fechado.</p>
    {ios && !installed ? <p className="mt-2 text-sm text-slate-300">No Safari, toque em Compartilhar → Adicionar à Tela de Início. Abra a SPATE Charge pelo ícone para ativar os avisos.</p> : null}
    {!supported ? <p className="mt-2 text-sm">Este navegador não oferece Web Push neste contexto. No iPhone, use o app adicionado à Tela de Início e acesso HTTPS.</p> : null}
    {status && !status.configured ? <p className="mt-2 text-sm">Os avisos ainda não foram configurados no servidor.</p> : null}
    <button className="mt-4 rounded-xl bg-primary px-4 py-3 font-semibold disabled:opacity-50" disabled={busy || !supported || !registration || (!enabled && (!status?.configured || (ios && !installed)))} type="button" onClick={() => void (enabled ? disable() : enable())}>
      {busy ? 'Aguarde...' : enabled ? 'Desativar notificações' : 'Ativar notificações'}
    </button>
    <p className="mt-2 text-xs text-slate-400">A preferência vale para esta sessão e aparelho. Ao sair, expirar a sessão ou perder acesso de administrador, novos envios são interrompidos.</p>
    {message ? <p role="status" className="mt-3 text-sm">{message}</p> : null}
  </section>
}
