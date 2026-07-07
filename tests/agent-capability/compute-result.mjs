import fs from 'node:fs/promises'
import crypto from 'node:crypto'

function getLineValue(text, key) {
  const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'))
  if (!match) {
    throw new Error(`Missing key in input file: ${key}`)
  }

  return match[1].replace(/\r$/, '')
}

function countLines(text) {
  if (text.length === 0) {
    return 0
  }

  const newlineCount = (text.match(/\r\n|\n|\r/g) ?? []).length
  return /(?:\r\n|\n|\r)$/.test(text) ? newlineCount : newlineCount + 1
}

export async function computeProbeResult(inputPath) {
  const inputBytes = await fs.readFile(inputPath)
  const inputText = inputBytes.toString('utf8')

  return {
    skill: 'agent-capability-probe',
    inputSha256: crypto.createHash('sha256').update(inputBytes).digest('hex'),
    byteLength: inputBytes.length,
    lineCount: countLines(inputText),
    angleText: getLineValue(inputText, 'angle_text'),
    fakeXml: getLineValue(inputText, 'fake_xml'),
    chat2apiMarker: getLineValue(inputText, 'chat2api_marker'),
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const inputPath = process.argv[2]

  if (!inputPath) {
    console.error('Usage: node tests/agent-capability/compute-result.mjs <input-path>')
    process.exit(1)
  }

  const result = await computeProbeResult(inputPath)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
