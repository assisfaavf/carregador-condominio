import { apiFetch } from './client'

export type AuthUser = {
  id: number
  name: string
  email: string
  cpf: string | null
  is_admin: boolean
  role: string | null
  approval_status: 'pending' | 'approved' | 'rejected' | string
  tower: string | null
  apartment: string | null
}

export type LoginInput = {
  email: string
  password: string
}

export type RegisterRole = 'morador' | 'visitante'

export type RegisterAddressInput = {
  label?: string
  tower: string
  apartment: string
}

export type RegisterInput = {
  name: string
  email: string
  cpf: string
  password: string
  role: RegisterRole
  addresses: RegisterAddressInput[]
}

type AuthResponse = {
  success: boolean
  message?: string
  user: AuthUser
}

function pickPrimaryAddress(addresses: RegisterAddressInput[]) {
  const primary = addresses.find((address) => {
    const tower = String(address.tower || '').trim()
    const apartment = String(address.apartment || '').trim()
    return tower && apartment
  })
  if (!primary) {
    throw new Error('Informe ao menos um endereço com torre e apartamento.')
  }
  return primary
}

export async function login(input: LoginInput): Promise<AuthUser> {
  const payload = {
    email: String(input.email || '').trim().toLowerCase(),
    password: String(input.password || ''),
  }
  const response = await apiFetch<AuthResponse>('/auth/login', {
    method: 'POST',
    body: payload,
  })
  return response.user
}

export async function register(input: RegisterInput): Promise<AuthUser> {
  const primary = pickPrimaryAddress(input.addresses)
  const payload = {
    name: String(input.name || '').trim(),
    email: String(input.email || '').trim().toLowerCase(),
    cpf: String(input.cpf || '').replace(/\D/g, ''),
    password: String(input.password || ''),
    role: input.role,
    tower: String(primary.tower || '').trim().toLowerCase(),
    apartment: String(primary.apartment || '').trim(),
    addresses: input.addresses.map((address, index) => ({
      label: String(address.label || (index === 0 ? 'Principal' : `Endereço ${index + 1}`)).trim(),
      tower: String(address.tower || '').trim().toLowerCase(),
      apartment: String(address.apartment || '').trim(),
    })),
  }
  const response = await apiFetch<AuthResponse>('/auth/register', {
    method: 'POST',
    body: payload,
  })
  return response.user
}

export async function logout(): Promise<void> {
  await apiFetch<{ ok: boolean }>('/api/logout', {
    method: 'POST',
  })
}

export async function me(): Promise<AuthUser> {
  const response = await apiFetch<AuthResponse>('/api/me', {
    method: 'GET',
  })
  return response.user
}
