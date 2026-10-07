const LAUNCHER_TO_MINECRAFT_LOCALE: Record<string, string> = {
  en: 'en_us',
  'en-IN': 'en_us',
  ar: 'ar_sa',
  'ar-EG': 'ar_sa',
  bn: 'bn_bd',
  de: 'de_de',
  'es-ES': 'es_es',
  fr: 'fr_fr',
  gl: 'gl_es',
  hi: 'hi_in',
  hu: 'hu_hu',
  id: 'id_id',
  'it-IT': 'it_it',
  'ja-JP': 'ja_jp',
  ko: 'ko_kr',
  kz: 'kk_kz',
  lolcat: 'lol_us',
  nl: 'nl_nl',
  pl: 'pl_pl',
  'pt-BR': 'pt_br',
  ru: 'ru_ru',
  sa: 'sa_in',
  ta: 'ta_in',
  tr: 'tr_tr',
  uk: 'uk_ua',
  vi: 'vi_vn',
  'zh-CN': 'zh_cn',
  'zh-HK': 'zh_hk',
  'zh-TW': 'zh_tw',
}

function isLegacyMinecraftLocaleFormat(minecraftVersion: string) {
  const match = /^1\.(\d+)(?:\.|$)/.exec(minecraftVersion)
  return !!match && Number(match[1]) <= 10
}

/**
 * Convert the launcher's UI locale into the Minecraft language id expected by
 * the selected game version. Minecraft <= 1.10 uses region casing like ru_RU;
 * newer versions use lowercase ids like ru_ru.
 */
export function resolveMinecraftLocale(launcherLocale: string, minecraftVersion: string) {
  const normalizedLauncherLocale = launcherLocale || 'en'
  let minecraftLocale = LAUNCHER_TO_MINECRAFT_LOCALE[normalizedLauncherLocale]

  if (!minecraftLocale) {
    const normalized = normalizedLauncherLocale.replace('-', '_')
    const parts = normalized.split('_')
    minecraftLocale = parts.length >= 2
      ? `${parts[0].toLowerCase()}_${parts[1].toLowerCase()}`
      : 'en_us'
  }

  if (!isLegacyMinecraftLocaleFormat(minecraftVersion)) {
    return minecraftLocale.toLowerCase()
  }

  const [language, region, ...rest] = minecraftLocale.split('_')
  if (!region) return minecraftLocale
  return [language.toLowerCase(), region.toUpperCase(), ...rest].join('_')
}

/**
 * Update only Minecraft's lang option, preserving all unrelated options.
 */
export function patchMinecraftLanguageOption(content: string, locale: string) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const line = `lang:${locale}`
  const langPattern = /^lang:.*$/m

  if (langPattern.test(content)) {
    return content.replace(langPattern, line)
  }

  if (!content) return line + eol
  return content.endsWith('\n') || content.endsWith('\r')
    ? content + line + eol
    : content + eol + line + eol
}
