import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useTheme } from '@/hooks/useTheme'
import { useSettingsStore, Theme, Language, AccentColor } from '@/stores/settingsStore'
import { Sun, Moon, PanelLeft, Languages, Palette, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'

const ACCENT_PRESETS: { value: AccentColor; labelKey: string; cssVar: string }[] = [
  { value: 'slate', labelKey: 'settings.accentColorSlate', cssVar: '--accent-slate' },
  { value: 'rose', labelKey: 'settings.accentColorRose', cssVar: '--accent-rose' },
  { value: 'lavender', labelKey: 'settings.accentColorLavender', cssVar: '--accent-lavender' },
  { value: 'sage', labelKey: 'settings.accentColorSage', cssVar: '--accent-sage' },
  { value: 'amber', labelKey: 'settings.accentColorAmber', cssVar: '--accent-amber' },
  { value: 'sand', labelKey: 'settings.accentColorSand', cssVar: '--accent-sand' },
]

export function AppearanceSettings() {
  const { t } = useTranslation()
  const { theme, setTheme, accentColor, setAccentColor } = useTheme()
  const { 
    sidebarCollapsed, 
    setSidebarCollapsed, 
    language, 
    setLanguage,
  } = useSettingsStore()

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-[var(--accent-primary)]/10 flex items-center justify-center">
              <Sun className="h-4 w-4 text-[var(--accent-primary)]" />
            </div>
            {t('settings.theme')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>{t('settings.theme')}</Label>
            <div className="flex gap-2">
              {([
                { value: 'light', labelKey: 'settings.themeLight', icon: Sun },
                { value: 'dark', labelKey: 'settings.themeDark', icon: Moon },
              ] as const).map(({ value, labelKey, icon: Icon }) => (
                <Button
                  key={value}
                  variant={theme === value ? 'default' : 'outline'}
                  onClick={() => setTheme(value)}
                  className="flex-1"
                >
                  <Icon className="mr-2 h-4 w-4" />
                  {t(labelKey)}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Palette className="h-4 w-4" />
              {t('settings.accentColor')}
            </Label>
            <p className="text-xs text-muted-foreground">{t('settings.accentColorDesc')}</p>
            <div className="grid grid-cols-3 gap-2 pt-1">
              {ACCENT_PRESETS.map(({ value, labelKey, cssVar }) => {
                const isActive = accentColor === value
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setAccentColor(value)}
                    className={`
                      relative flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm
                      transition-all duration-200 outline-none
                      ${isActive
                        ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/10 shadow-sm'
                        : 'border-border bg-card hover:border-[var(--accent-primary)]/40 hover:bg-muted/50'
                      }
                    `}
                  >
                    <span
                      className="h-5 w-5 shrink-0 rounded-full shadow-inner"
                      style={{ backgroundColor: `var(${cssVar})` }}
                    />
                    <span className={`truncate ${isActive ? 'font-medium text-[var(--accent-primary)]' : 'text-muted-foreground'}`}>
                      {t(labelKey)}
                    </span>
                    {isActive && (
                      <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--accent-primary)]" />
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-[var(--accent-primary)]/10 flex items-center justify-center">
              <Languages className="h-4 w-4 text-[var(--accent-primary)]" />
            </div>
            {t('settings.language')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Label>{t('settings.language')}</Label>
            <Select value={language} onValueChange={(v) => setLanguage(v as Language)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="zh-CN">{t('settings.languageZh')}</SelectItem>
                <SelectItem value="en-US">{t('settings.languageEn')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-[var(--accent-primary)]/10 flex items-center justify-center">
              <PanelLeft className="h-4 w-4 text-[var(--accent-primary)]" />
            </div>
            {t('settings.sidebarCollapsed')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>{t('settings.sidebarCollapsed')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('settings.sidebarCollapsedHelp')}
              </p>
            </div>
            <Switch
              checked={sidebarCollapsed}
              onCheckedChange={setSidebarCollapsed}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
