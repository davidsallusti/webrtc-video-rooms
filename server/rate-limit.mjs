export function createRateLimiter({ limit, windowMs, code = 'rate_limited', message = 'Too many requests. Try again shortly.' }) {
  const buckets = new Map()

  function check(key) {
    const bucketKey = String(key || 'unknown')
    const now = Date.now()
    const current = buckets.get(bucketKey)

    if (!current || current.resetAt <= now) {
      buckets.set(bucketKey, { count: 1, resetAt: now + windowMs })
      return
    }

    if (current.count >= limit) {
      const error = new Error(message)
      error.code = code
      error.status = 429
      throw error
    }

    current.count += 1
  }

  function reset() {
    buckets.clear()
  }

  return { check, reset }
}

export function readLimit(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}
