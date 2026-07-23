import axios from 'axios'
import { FAKE_HEADERS } from './renderer.ts'

const DEEPSEEK_API_BASE = 'https://chat.deepseek.com/api'
export const DEEPSEEK_COMPLETION_TARGET_PATH = '/api/v0/chat/completion'

export interface DeepSeekPowChallenge {
  algorithm: string
  challenge: string
  salt: string
  difficulty: number
  expire_at: number
  signature: string
}

interface DeepSeekHashSolver {
  calculateHash(
    algorithm: string,
    challenge: string,
    salt: string,
    difficulty: number,
    expireAt: number,
  ): number | undefined
}

export interface DeepSeekPowDependencies {
  postChallenge: (
    url: string,
    body: { target_path: string },
    config: {
      headers: Record<string, string>
      timeout: number
      validateStatus: () => boolean
    },
  ) => Promise<{ status: number; data?: any }>
  getHash: () => Promise<DeepSeekHashSolver>
}

const defaultDependencies: DeepSeekPowDependencies = {
  postChallenge: axios.post.bind(axios),
  getHash: async () => (await import('../../../lib/challenge.ts')).getDeepSeekHash(),
}

export async function getDeepSeekPowChallenge(
  token: string,
  targetPath: string = DEEPSEEK_COMPLETION_TARGET_PATH,
  deps: Partial<DeepSeekPowDependencies> = {},
): Promise<DeepSeekPowChallenge> {
  const resolvedDeps = { ...defaultDependencies, ...deps }
  const result = await resolvedDeps.postChallenge(
    `${DEEPSEEK_API_BASE}/v0/chat/create_pow_challenge`,
    { target_path: targetPath },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        ...FAKE_HEADERS,
      },
      timeout: 15000,
      validateStatus: () => true,
    },
  )

  const bizData = result.data?.data?.biz_data || result.data?.biz_data
  if (result.status !== 200 || !bizData?.challenge) {
    throw new Error(`Failed to get DeepSeek PoW challenge: ${result.data?.msg || result.data?.data?.biz_msg || result.status}`)
  }

  return bizData.challenge
}

export async function calculateDeepSeekPowResponse(
  challenge: DeepSeekPowChallenge,
  targetPath: string = DEEPSEEK_COMPLETION_TARGET_PATH,
  deps: Partial<DeepSeekPowDependencies> = {},
): Promise<string> {
  const resolvedDeps = { ...defaultDependencies, ...deps }
  const { algorithm, challenge: challengeStr, salt, difficulty, expire_at, signature } = challenge

  if (algorithm !== 'DeepSeekHashV1') {
    throw new Error(`Unsupported DeepSeek PoW algorithm: ${algorithm}`)
  }

  const deepSeekHash = await resolvedDeps.getHash()
  const answer = deepSeekHash.calculateHash(algorithm, challengeStr, salt, difficulty, expire_at)

  if (answer === undefined) {
    throw new Error('DeepSeek PoW challenge calculation failed')
  }

  return Buffer.from(JSON.stringify({
    algorithm,
    challenge: challengeStr,
    salt,
    answer,
    signature,
    target_path: targetPath,
  })).toString('base64')
}

export async function buildDeepSeekPowResponse(
  token: string,
  targetPath: string = DEEPSEEK_COMPLETION_TARGET_PATH,
  deps: Partial<DeepSeekPowDependencies> = {},
): Promise<string> {
  const challenge = await getDeepSeekPowChallenge(token, targetPath, deps)
  return calculateDeepSeekPowResponse(challenge, targetPath, deps)
}

export async function addDeepSeekPowHeader<T extends { headers: Record<string, string> }>(
  request: T,
  token: string,
  deps: Partial<DeepSeekPowDependencies> = {},
): Promise<T> {
  const powResponse = await buildDeepSeekPowResponse(token, DEEPSEEK_COMPLETION_TARGET_PATH, deps)
  return {
    ...request,
    headers: {
      ...request.headers,
      'x-ds-pow-response': powResponse,
    },
  }
}
