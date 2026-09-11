const jumlaKhaleejDeliveryCities = [
  { key: 'kirkuk', fee: 3000, names: { en: 'Kirkuk', ar: 'كركوك', ku: 'کەرکووک' } },
  { key: 'baghdad', fee: 5000, names: { en: 'Baghdad', ar: 'بغداد', ku: 'بەغدا' } },
  { key: 'erbil', fee: 5000, names: { en: 'Erbil', ar: 'أربيل', ku: 'هەولێر' } },
  { key: 'duhok', fee: 5000, names: { en: 'Duhok', ar: 'دهوك', ku: 'دهۆک' } },
  { key: 'sulaymaniyah', fee: 5000, names: { en: 'Sulaymaniyah', ar: 'السليمانية', ku: 'سلێمانی' } },
  { key: 'halabja', fee: 5000, names: { en: 'Halabja', ar: 'حلبجة', ku: 'هەڵەبجە' } },
  { key: 'al-anbar', fee: 6000, names: { en: 'Al Anbar', ar: 'الأنبار', ku: 'ئەنبار' } },
  { key: 'babil', fee: 6000, names: { en: 'Babil', ar: 'بابل', ku: 'بابل' } },
  { key: 'basra', fee: 6000, names: { en: 'Basra', ar: 'البصرة', ku: 'بەسرە' } },
  { key: 'dhi-qar', fee: 6000, names: { en: 'Dhi Qar', ar: 'ذي قار', ku: 'ذي قار' } },
  { key: 'diyala', fee: 6000, names: { en: 'Diyala', ar: 'ديالى', ku: 'دیالە' } },
  { key: 'karbala', fee: 6000, names: { en: 'Karbala', ar: 'كربلاء', ku: 'کەربەلا' } },
  { key: 'maysan', fee: 6000, names: { en: 'Maysan', ar: 'ميسان', ku: 'مەیسان' } },
  { key: 'muthanna', fee: 6000, names: { en: 'Muthanna', ar: 'المثنى', ku: 'موسەننا' } },
  { key: 'najaf', fee: 6000, names: { en: 'Najaf', ar: 'نجف', ku: 'نەجەف' } },
  { key: 'nineveh', fee: 6000, names: { en: 'Nineveh', ar: 'نينوى', ku: 'نەینەوا' } },
  { key: 'al-qadisiyyah', fee: 6000, names: { en: 'Al-Qadisiyyah', ar: 'القادسية', ku: 'قادسیە' } },
  { key: 'salah-al-din', fee: 6000, names: { en: 'Salah al-Din', ar: 'صلاح الدين', ku: 'سەلاحەدین' } },
  { key: 'wasit', fee: 6000, names: { en: 'Wasit', ar: 'واسط', ku: 'واسط' } }
] as const

export function getJumlaKhaleejDeliveryCity(key: string | null | undefined) {
  return jumlaKhaleejDeliveryCities.find((city) => city.key === key) ?? null
}
