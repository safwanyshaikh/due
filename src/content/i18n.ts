/**
 * Language layer (beta). English is the source of truth and the default; Hindi covers the landing, the Home
 * summary and the Savings headline only. Anything without a Hindi string falls back to English, so a missing
 * translation can never blank the screen. Legal text, Terms and Privacy stay in English (reviewed wording).
 */
export type Lang = 'en' | 'hi';
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'hi', label: 'Hindi (beta)' },
];

const EN = {
  'landing.headline': 'Same life. Smaller bills.',
  'landing.sub':
    'Due checks your subscriptions, recharges, rides and EMIs, and shows where you’re overpaying.',
  'landing.benefit1': 'See every bill, subscription and EMI in one place.',
  'landing.benefit2': 'Get reminded before money leaves your account.',
  'landing.benefit3': 'Spot where you may be overpaying, then decide for yourself.',
  'landing.cta': 'Start free, no sign-up',
  'landing.privacy': 'Your statements are read on your phone.',
  'home.morning': 'Good morning',
  'home.afternoon': 'Good afternoon',
  'home.evening': 'Good evening',
  'home.planned': 'Planned in {m}',
  'home.next30': 'Due in the next 30 days',
  'home.found1': 'found · 1 move to look at',
  'home.foundN': 'found · {n} moves to look at',
  'home.seeHow': 'See how →',
  'home.perMonth': '/month',
  'savings.title': 'Savings',
  'savings.found': 'Found',
  'savings.saved': 'Saved',
} as const;

export type StrKey = keyof typeof EN;

const HI: Partial<Record<StrKey, string>> = {
  'landing.headline': 'वही ज़िंदगी, छोटे बिल।',
  'landing.sub':
    'Due आपके सब्सक्रिप्शन, रिचार्ज, राइड और EMI देखता है और बताता है कि आप कहाँ ज़्यादा दे रहे हैं।',
  'landing.benefit1': 'हर बिल, सब्सक्रिप्शन और EMI एक ही जगह देखें।',
  'landing.benefit2': 'पैसे कटने से पहले याद दिलाया जाए।',
  'landing.benefit3': 'देखें कहाँ ज़्यादा दे रहे हैं, फिर खुद तय करें।',
  'landing.cta': 'मुफ़्त शुरू करें, साइन-अप नहीं',
  'landing.privacy': 'आपके स्टेटमेंट आपके फ़ोन पर ही पढ़े जाते हैं।',
  'home.morning': 'सुप्रभात',
  'home.afternoon': 'नमस्कार',
  'home.evening': 'शुभ संध्या',
  'home.planned': '{m} में तय',
  'home.next30': 'अगले 30 दिनों में देय',
  'home.found1': 'मिला · 1 सुझाव देखने लायक',
  'home.foundN': 'मिला · {n} सुझाव देखने लायक',
  'home.seeHow': 'देखें →',
  'home.perMonth': '/माह',
  'savings.title': 'बचत',
  'savings.found': 'मिला',
  'savings.saved': 'बचाया',
};

export function tr(lang: Lang, key: StrKey, vars: Record<string, string | number> = {}): string {
  const raw = (lang === 'hi' ? HI[key] : undefined) ?? EN[key];
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}

export const HI_KEYS = Object.keys(HI) as StrKey[];
export const EN_KEYS = Object.keys(EN) as StrKey[];
