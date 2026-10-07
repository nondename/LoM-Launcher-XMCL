import { describe, expect, it } from 'vitest'
import { patchMinecraftLanguageOption, resolveMinecraftLocale } from './minecraftLocale'

describe('Minecraft locale sync', () => {
  it('maps Russian launcher locale to modern Minecraft locale', () => {
    expect(resolveMinecraftLocale('ru', '1.20.1')).toBe('ru_ru')
  })

  it('uses legacy region casing for Minecraft 1.7.10', () => {
    expect(resolveMinecraftLocale('ru', '1.7.10')).toBe('ru_RU')
    expect(resolveMinecraftLocale('en', '1.10.2')).toBe('en_US')
  })

  it('uses lowercase locale ids from Minecraft 1.11 onward', () => {
    expect(resolveMinecraftLocale('de', '1.11.2')).toBe('de_de')
    expect(resolveMinecraftLocale('pt-BR', '1.20.1')).toBe('pt_br')
  })

  it('maps launcher-only locale names to Minecraft equivalents', () => {
    expect(resolveMinecraftLocale('kz', '1.20.1')).toBe('kk_kz')
    expect(resolveMinecraftLocale('lolcat', '1.20.1')).toBe('lol_us')
    expect(resolveMinecraftLocale('zh-HK', '1.20.1')).toBe('zh_hk')
  })

  it('patches only lang in an existing options file', () => {
    expect(patchMinecraftLanguageOption(
      'music:0.5\nlang:en_us\nrenderDistance:12\n',
      'ru_ru',
    )).toBe('music:0.5\nlang:ru_ru\nrenderDistance:12\n')
  })

  it('creates lang when options are missing', () => {
    expect(patchMinecraftLanguageOption('', 'ru_RU')).toBe('lang:ru_RU\n')
  })

  it('preserves CRLF options files', () => {
    expect(patchMinecraftLanguageOption(
      'music:0.5\r\nlang:en_US\r\nrenderDistance:12\r\n',
      'ru_RU',
    )).toBe('music:0.5\r\nlang:ru_RU\r\nrenderDistance:12\r\n')
  })
})
