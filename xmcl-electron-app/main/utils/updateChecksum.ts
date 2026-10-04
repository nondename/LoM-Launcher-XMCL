import { checksum } from '~/util/fs'

/**
 * SHA-256 файла строчными hex-символами, либо пустая строка, если посчитать
 * не удалось.
 *
 * `checksum()` при отсутствии файла не отклоняет промис, а возвращает
 * `undefined` (ENOENT), а `hash.read()` может вернуть `null` для пустого
 * файла. Сравнение дайджестов, написанное как
 * `(await checksum(path, 'sha256')).catch(() => '')` + `.toLowerCase()`,
 * поэтому падало с `Cannot read properties of undefined (reading
 * 'toLowerCase')` на самой первой загрузке обновления: файл
 * `pending_update` ещё не существует. Здесь оба случая нормализуются в `''`.
 */
export async function sha256Of(path: string): Promise<string> {
  const value = await checksum(path, 'sha256').catch(() => undefined)
  return typeof value === 'string' ? value.toLowerCase() : ''
}
