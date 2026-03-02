export class ApiError extends Error {
  status: number
  code: string
  data: unknown

  constructor(message: string, status: number, code: string, data: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.data = data
  }
}

type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

type ApiRequestOptions = {
  method?: ApiMethod
  body?: unknown
  headers?: HeadersInit
  signal?: AbortSignal
}

const baseUrl = ''

function isBodyJsonSerializable(body: unknown) {
  if (body == null) return false
  if (typeof body !== 'object') return false
  if (body instanceof FormData) return false
  if (body instanceof URLSearchParams) return false
  if (body instanceof Blob) return false
  if (body instanceof ArrayBuffer) return false
  return true
}

async function parseResponseBody(response: Response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function pickErrorMessage(parsed: unknown, fallback: string) {
  if (typeof parsed === 'object' && parsed !== null) {
    const maybeMessage = (parsed as { message?: unknown }).message
    if (typeof maybeMessage === 'string' && maybeMessage.trim()) {
      return maybeMessage
    }
  }
  return fallback
}

export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers, signal } = options
  const url = `${baseUrl}${path}`
  const requestHeaders = new Headers(headers || {})
  const init: RequestInit = {
    method,
    credentials: 'include',
    headers: requestHeaders,
    signal,
  }

  if (body != null) {
    if (isBodyJsonSerializable(body)) {
      if (!requestHeaders.has('Content-Type')) {
        requestHeaders.set('Content-Type', 'application/json')
      }
      init.body = JSON.stringify(body)
    } else {
      init.body = body as BodyInit
    }
  }

  const response = await fetch(url, init)
  const parsed = await parseResponseBody(response)

  if (response.status === 401) {
    throw new ApiError('unauthorized', 401, 'unauthorized', parsed)
  }

  if (!response.ok) {
    throw new ApiError(
      pickErrorMessage(parsed, `Request failed with status ${response.status}`),
      response.status,
      'request_failed',
      parsed,
    )
  }

  return parsed as T
}
