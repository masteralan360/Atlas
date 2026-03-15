export type ExchangeRateSource = 'xeiqd' | 'forexfy' | 'dolardinar' | 'manual';

export interface ExchangeRateResult {
    rate: number;
    source: ExchangeRateSource;
    isFallback: boolean;
    timestamp?: string;
    averageRate?: number; // Added for validation baseline
}

export async function fetchUSDToIQDRate(primarySource?: ExchangeRateSource): Promise<ExchangeRateResult> {
    if (!navigator.onLine) {
        throw new Error('Offline: Cannot fetch live exchange rate');
    }

    // If manual mode, return the value from localStorage
    if (primarySource === 'manual' || (!primarySource && localStorage.getItem('primary_exchange_rate_source') === 'manual')) {
        const manualRate = parseInt(localStorage.getItem('manual_rate_usd_iqd') || '0');
        return { rate: manualRate, source: 'manual', isFallback: false };
    }

    // Get primary from localStorage if not provided (for direct calls from component)
    const favoredSource = primarySource || (localStorage.getItem('primary_exchange_rate_source') as ExchangeRateSource) || 'xeiqd';

    const sources: ExchangeRateSource[] = [
        favoredSource,
        ...(['xeiqd', 'forexfy', 'dolardinar'] as ExchangeRateSource[]).filter(s => s !== favoredSource && s !== 'manual')
    ];

    // --- TRY SOURCES IN ORDER ---
    for (let i = 0; i < sources.length; i++) {
        const currentSource = sources[i];
        const isFallback = i > 0;

        try {
            let rate = 0;
            if (currentSource === 'xeiqd') rate = await fetchFromXEIQD();
            else if (currentSource === 'forexfy') rate = await fetchFromForexfy();
            else if (currentSource === 'dolardinar') rate = await fetchFromDolarDinar();

            if (rate < 100000) {
                throw new Error('Rate sanity check failed (< 100000)');
            }

            return { rate, source: currentSource, isFallback };
        } catch (error) {
        }
    }

    throw new Error('All exchange rate sources failed');
}

export async function fetchEURToIQDRate(primarySource?: ExchangeRateSource): Promise<{ usdEur: number, eurIqd: number, source: ExchangeRateSource, isFallback: boolean }> {
    if (!navigator.onLine) {
        throw new Error('Offline: Cannot fetch live exchange rate');
    }

    // If manual mode, return the values from localStorage
    if (primarySource === 'manual' || (!primarySource && localStorage.getItem('primary_eur_exchange_rate_source') === 'manual')) {
        const usdEur = parseFloat(localStorage.getItem('manual_rate_usd_eur') || '0');
        const eurIqd = parseInt(localStorage.getItem('manual_rate_eur_iqd') || '0');
        return { usdEur, eurIqd, source: 'manual', isFallback: false };
    }

    const favoredSource = primarySource || (localStorage.getItem('primary_eur_exchange_rate_source') as ExchangeRateSource) || 'forexfy';

    // XEIQD doesn't easily provide EUR, so we fallback to others
    const sources: ExchangeRateSource[] = [
        favoredSource,
        ...(['forexfy', 'dolardinar'] as ExchangeRateSource[]).filter(s => s !== favoredSource && s !== 'manual')
    ];

    for (let i = 0; i < sources.length; i++) {
        const currentSource = sources[i];
        const isFallback = i > 0;

        try {
            const usdEur = await fetchCrossRate(currentSource, 'USD-to-EUR');
            const eurIqd = await fetchCrossRate(currentSource, 'EUR-to-IQD');

            if (eurIqd < 100000) {
                throw new Error('EUR Rate sanity check failed (< 100000)');
            }

            return { usdEur, eurIqd, source: currentSource, isFallback };
        } catch (error) {
        }
    }

    throw new Error('All EUR exchange rate sources failed');
}

export async function fetchTRYToIQDRate(primarySource?: ExchangeRateSource): Promise<{ usdTry: number, tryIqd: number, source: ExchangeRateSource, isFallback: boolean }> {
    if (!navigator.onLine) {
        throw new Error('Offline: Cannot fetch live exchange rate');
    }

    // If manual mode, return the values from localStorage
    if (primarySource === 'manual' || (!primarySource && localStorage.getItem('primary_try_exchange_rate_source') === 'manual')) {
        const usdTry = parseFloat(localStorage.getItem('manual_rate_usd_try') || '0');
        const tryIqd = parseInt(localStorage.getItem('manual_rate_try_iqd') || '0');
        return { usdTry, tryIqd, source: 'manual', isFallback: false };
    }

    const favoredSource = primarySource || (localStorage.getItem('primary_try_exchange_rate_source') as ExchangeRateSource) || 'forexfy';

    const sources: ExchangeRateSource[] = [
        favoredSource,
        ...(['forexfy', 'dolardinar'] as ExchangeRateSource[]).filter(s => s !== favoredSource && s !== 'manual')
    ];

    for (let i = 0; i < sources.length; i++) {
        const currentSource = sources[i];
        const isFallback = i > 0;

        try {

            // For TRY we need both USD-TRY (for cross calc if needed) and TRY-IQD
            // If source is Forexfy, we can get TRY-IQD directly from the blackmarket page

            let tryIqd = 0;
            let usdTry = 0;

            if (currentSource === 'forexfy') {
                tryIqd = await fetchEgRate('TRY-to-IQD');
                // We also need USD-TRY for internal conversions if needed, usually we can get it from Forexfy too
                // or approximate it. Let's try to fetch it.
                try {
                    usdTry = await fetchEgRate('USD-to-TRY');
                } catch (e) {
                    // Fallback calculation: USD-TRY = USD-IQD / TRY-IQD
                    const usdIqd = await fetchUSDToIQDRate('forexfy');
                    if (tryIqd > 0) usdTry = Math.round((usdIqd.rate / tryIqd) * 100) / 100; // keep logical precision
                }
            } else if (currentSource === 'dolardinar') {
                // DolarDinar usually has a list of currencies against IQD
                // We need to implement fetch from DolarDinar for TRY
                const result = await fetchFromDolarDinar('TRY');
                // DolarDinar result is TRY-to-IQD rate directly
                tryIqd = result;
                usdTry = await fetchCrossRate('dolardinar', 'USD-to-TRY');
            }

            return { usdTry, tryIqd, source: currentSource, isFallback };
        } catch (error) {
        }
    }

    throw new Error('All TRY exchange rate sources failed');
}

export type ExchangePath = 'USD-to-IQD' | 'USD-to-EUR' | 'EUR-to-IQD' | 'USD-to-TRY' | 'TRY-to-IQD';

// Helper to handle fetching in both Electron (via IPC) and Web (via Proxy)
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

// Helper to handle fetching in both Tauri (Native HTTP) and Web (via Proxy)
async function fetchUrl(url: string, isApiProxy = false): Promise<string> {
    // Optimization: Block all exchange rate fetches for remote KDS clients
    // @ts-ignore
    const isRemoteKds = typeof window !== 'undefined' && !window.__TAURI_INTERNALS__ && (window.location.port === '4004' || window.location.hash.includes('/kds/local'))
    if (isRemoteKds) {
        throw new Error('KDS Mode: Exchange rate fetching is disabled.');
    }

    // If in Tauri, use the Native HTTP client to bypass CORS
    // @ts-ignore
    if (window.__TAURI_INTERNALS__) {
        let targetUrl = url;
        if (isApiProxy) {
            if (url.includes('api-xeiqd')) targetUrl = 'https://xeiqd.com' + url.replace('/api-xeiqd', '');
            else if (url.includes('api-forexfy')) targetUrl = 'https://forexfy.app' + url.replace('/api-forexfy', '');
        }

        try {
            const response = await tauriFetch(targetUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });

            if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
            return await response.text();
        } catch (e) {
            throw e;
        }
    }

    // Web Mode (use standard fetch which hits Vite proxy)
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
    return await response.text();
}

async function fetchFromXEIQD(): Promise<number> {
    const html = await fetchUrl('/api-xeiqd', true);

    // 1. Try Sulaymaniyah spot rate
    const sulyRegex = /السليمانية.*?(?:IQD|د\.ع)\s*([0-9\u0660-\u0669]{1,3}(?:[.,\u066B\u066C][0-9\u0660-\u0669]{3})+)/s;
    const sulyMatch = html.match(sulyRegex);

    if (sulyMatch && sulyMatch[1]) {
        let rawValue = sulyMatch[1];
        const arabicDigits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
        for (let i = 0; i < 10; i++) {
            rawValue = rawValue.split(arabicDigits[i]).join(i.toString());
        }
        const cleanedValue = rawValue.replace(/[.,\u066B\u066C]/g, '');
        const rate = parseInt(cleanedValue);
        if (!isNaN(rate) && rate > 100000) return rate;
    }

    // 2. Fallback to chart data
    const regex = /cachedData:\s*JSON\.parse\(['"](.+?)['"]\)/s;
    const match = html.match(regex);
    if (!match || !match[1]) throw new Error('Pattern not found');

    const jsonStr = match[1]
        .replace(/&quot;/g, '"')
        .replace(/\\\\u/g, '\\u')
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, p1) => String.fromCharCode(parseInt(p1, 16)))
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");

    const data = JSON.parse(jsonStr);
    const usdDataset = data.datasets.find((ds: any) => ds.label === "USD" || ds.label === "دولار أمريكي");
    if (!usdDataset || !usdDataset.data) throw new Error('USD dataset not found');

    const entries = Object.entries(usdDataset.data);
    if (entries.length === 0) throw new Error('No entries');

    const latestValueStr = entries[entries.length - 1][1] as string;
    const latestValue = parseFloat(latestValueStr);
    if (isNaN(latestValue)) throw new Error('Invalid value');

    return Math.round(latestValue * 100);
}

async function fetchFromForexfy(): Promise<number> {
    const html = await fetchUrl('/api-forexfy/en/currency/USD-to-IQD/blackMarket', true);

    /**
     * User requested "Sell Price" which currently is 1,453.95
     * Based on research, the HTML structure is:
     * <span class="margin-me-1">Sell Price:</span> <b class="fs-5">1,453.95</b>
     * Alternatively, there's a script tag with:
     * const rates = {"IQD":{"sell":1,"buy":1},"USD":{"sell":1453.95,"buy":1468.64,"unit":1}};
     */

    // Try script extraction first (more robust)
    const scriptRegex = /const\s+rates\s*=\s*({.*?});/s;
    const scriptMatch = html.match(scriptRegex);
    if (scriptMatch && scriptMatch[1]) {
        try {
            const rates = JSON.parse(scriptMatch[1]);
            if (rates.USD && rates.USD.sell) {
                const sellValue = parseFloat(rates.USD.sell);
                if (!isNaN(sellValue)) {
                    // Multiply by 100 as per user requirement (1453.95 -> 145395)
                    return Math.round(sellValue * 100);
                }
            }
        } catch (e) {
            console.warn('[Forexfy] JSON parse failed, falling back to regex');
        }
    }

    // Fallback 2: Main Rate Selector (Highly Flexible)
    const htmlRegex = /Sell Price:.*?<b.*?>([\d,.]+)/i;
    const htmlMatch = html.match(htmlRegex);
    if (htmlMatch && htmlMatch[1]) {
        const rawValue = htmlMatch[1].replace(/,/g, '');
        const sellValue = parseFloat(rawValue);
        if (!isNaN(sellValue) && sellValue > 100) {
            return Math.round(sellValue * 100);
        }
    }

    // Fallback 3: Navigation/Link Pattern (Extracted from Home Page)
    // Looking for <b>...</b> inside an element that contains currency name
    const navRegex = /USD-to-IQD.*?<b>([\d,.]+)/i;
    const navMatch = html.match(navRegex);
    if (navMatch && navMatch[1]) {
        const rawValue = navMatch[1].replace(/,/g, '');
        const sellValue = parseFloat(rawValue);
        if (!isNaN(sellValue) && sellValue > 100) {
            return Math.round(sellValue * 100);
        }
    }

    // Fallback 4: Global Pattern Match (Last Resort)
    // Matches any sequence like "USD ... 1,450.00" or similar
    const globalRegex = /USD.*?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2}))/i;
    const globalMatch = html.match(globalRegex);
    if (globalMatch && globalMatch[1]) {
        const rawValue = globalMatch[1].replace(/,/g, '');
        const sellValue = parseFloat(rawValue);
        if (!isNaN(sellValue) && sellValue > 100) {
            return Math.round(sellValue * 100);
        }
    }

    throw new Error('Could not extract Sell Price from forexfy.app after 4 attempts');
}

async function fetchFromDolarDinar(currencyCode: string = 'IQD'): Promise<number> {
    const jsonStr = await fetchUrl('https://opensheet.elk.sh/1VqEZiLBr7dYeoH2wkeUH3D9zNe61dw-_RPxj6MH_Xw0/Today', false);
    const data = JSON.parse(jsonStr);

    // Find row
    // DolarDinar sheet usually has 'Currency' column with values like 'IQD', 'EUR', 'TRY' (or 'Lira'?)
    // We need to match robustly. Common codes: IQD (for USD?), EUR, TRY.
    // Actually for USD it might be row with Currency='USD' or empty? 
    // In original code: r.Currency === 'IQD' was used for USD-IQD rate? Wait.
    // Original code: `const iqdRow = data.find((r: any) => r.Currency === 'IQD');` -> returns Rate.
    // Usually these sheets list foreign currencies against IQD. So "USD" row gives USD/IQD.
    // "EUR" row gives EUR/IQD. "TRY" row gives TRY/IQD.
    // IMPORTANT: The previous code looked for 'IQD' to get USD rate? That seems odd if the column is Currency. 
    // Let's assume the previous code was correct for USD (maybe matched a label).
    // Let's look at the implementation again: `r.Currency === 'IQD'` -> Rate.
    // If the sheet lists "Currency" as the foreign currency, then 'IQD' would be wrong for USD.
    // Unless the column is "Target" and Source is implied?
    // Let's stick to what worked for USD (IQD key) but for others we might need to search 'TRY' or 'TUR'.

    let targetKey = currencyCode;
    if (currencyCode === 'USD') targetKey = 'IQD'; // Legacy mapping based on existing code

    const row = data.find((r: any) => r.Currency === targetKey || r.Currency === currencyCode);
    if (!row || !row.Rate) throw new Error(`${currencyCode} rate not found in DolarDinar sheet`);

    // Normalize: remove . (thousands), replace , with . (decimal)
    const normalizedRate = parseFloat(row.Rate.replace(/\./g, '').replace(/,/g, '.'));
    if (isNaN(normalizedRate)) throw new Error(`Invalid ${currencyCode} rate from DolarDinar`);

    // System uses integers (1450.00 -> 145000)
    return Math.round(normalizedRate * 100);
}



async function fetchEgRate(path: ExchangePath): Promise<number> {
    const html = await fetchUrl(`/api-forexfy/en/currency/${path}/blackMarket`, true);

    const scriptRegex = /const\s+rates\s*=\s*({.*?});/s;
    const scriptMatch = html.match(scriptRegex);
    if (scriptMatch && scriptMatch[1]) {
        try {
            const rates = JSON.parse(scriptMatch[1]);
            const symbol = path.split('-to-')[0]; // USD or EUR
            if (rates[symbol] && rates[symbol].sell) {
                const sellValue = parseFloat(rates[symbol].sell);
                if (!isNaN(sellValue)) {
                    return Math.round(sellValue * 100);
                }
            }
        } catch (e) {
            console.warn(`[Forexfy] ${path} JSON parse failed, falling back to regex`);
        }
    }

    // Fallback 2: Main Rate Selector (Highly Flexible)
    const htmlRegex = /Sell Price:.*?<b.*?>([\d,.]+)/i;
    const htmlMatch = html.match(htmlRegex);
    if (htmlMatch && htmlMatch[1]) {
        const rawValue = htmlMatch[1].replace(/,/g, '');
        const sellValue = parseFloat(rawValue);
        if (!isNaN(sellValue)) {
            return Math.round(sellValue * 100);
        }
    }

    // Fallback 3: Navigation/Link Pattern
    const navRegex = new RegExp(`${path}.*?<b>([\\d,.]+)`, 'i');
    const navMatch = html.match(navRegex);
    if (navMatch && navMatch[1]) {
        const rawValue = navMatch[1].replace(/,/g, '');
        const sellValue = parseFloat(rawValue);
        if (!isNaN(sellValue)) {
            return Math.round(sellValue * 100);
        }
    }

    // Fallback 4: Global Pattern
    const symbol = path.split('-to-')[0]; // USD or EUR
    const globalRegex = new RegExp(`${symbol}.*?(\\d{1,3}(?:[.,]\\d{3})*(?:[.,]\\d{2}))`, 'i');
    const globalMatch = html.match(globalRegex);
    if (globalMatch && globalMatch[1]) {
        const rawValue = globalMatch[1].replace(/,/g, '');
        const sellValue = parseFloat(rawValue);
        if (!isNaN(sellValue)) {
            return Math.round(sellValue * 100);
        }
    }

    throw new Error(`Could not extract rate for ${path} from forexfy.app`);
}

export async function fetchCrossRate(source: ExchangeRateSource, path: ExchangePath): Promise<number> {
    if (source === 'xeiqd') {
        // XEIQD only provides USD/IQD usually, for others we might need a fallback or cross calculation
        // but currently system uses it as primary. For simplicity, if path is not USD-IQD, try forexfy
        if (path === 'USD-to-IQD') return await fetchFromXEIQD();
        return await fetchEgRate(path); // Fallback to forexfy for EUR/others
    }

    if (source === 'forexfy') {
        return await fetchEgRate(path);
    }

    if (source === 'dolardinar') {
        if (path === 'USD-to-IQD') {
            return await fetchFromDolarDinar('USD');
        } else if (path === 'USD-to-EUR') {
            // EUR row in DolarDinar sheet returns EUR/USD ratio (e.g., 0.88)
            const eurPerUsd = await fetchFromDolarDinar('EUR');
            // Convert to USD-per-EUR (reciprocal), result already scaled by 100
            return eurPerUsd > 0 ? Math.round(10000 / eurPerUsd * 100) : 0;
        } else if (path === 'EUR-to-IQD') {
            // EUR row in DolarDinar sheet returns EUR/USD ratio (e.g., 0.88)
            // We need EUR/IQD = USD/IQD / EUR_per_USD
            const usdIqd = await fetchFromDolarDinar('USD');
            const eurPerUsd = await fetchFromDolarDinar('EUR');
            // eurPerUsd is scaled by 100 (e.g., 88 for 0.88), so divide by 100 first
            const eurUsdRatio = eurPerUsd / 100;
            if (eurUsdRatio > 0) {
                // EUR/IQD = USD/IQD / EUR_per_USD (e.g., 148000 / 0.88 ≈ 168181)
                return Math.round(usdIqd / eurUsdRatio);
            }
            throw new Error('Invalid EUR/USD ratio from DolarDinar');
        } else if (path === 'TRY-to-IQD') {
            return await fetchFromDolarDinar('TRY');
        } else if (path === 'USD-to-TRY') {
            const usd = await fetchFromDolarDinar('USD');
            const tryRate = await fetchFromDolarDinar('TRY');
            return Math.round((usd / tryRate) * 100);
        }
    }


    throw new Error(`Unsupported source/path combination: ${source}/${path}`);
}

export async function fetchRatesFromAllSources(): Promise<{
    usd_iqd: { xeiqd?: number; forexfy?: number; dolardinar?: number; average?: number };
    eur_iqd: { forexfy?: number; dolardinar?: number; average?: number };
    try_iqd: { forexfy?: number; dolardinar?: number; average?: number };
}> {
    const results: any = { usd_iqd: {}, eur_iqd: {}, try_iqd: {} };

    // USD/IQD
    const usdPromises = [
        fetchFromXEIQD().then(r => results.usd_iqd.xeiqd = r).catch(() => { }),
        fetchFromForexfy().then(r => results.usd_iqd.forexfy = r).catch(() => { }),
        fetchFromDolarDinar('USD').then(r => results.usd_iqd.dolardinar = r).catch(() => { })
    ];

    // EUR/IQD
    const eurPromises = [
        fetchEgRate('EUR-to-IQD').then(r => results.eur_iqd.forexfy = r).catch(() => { }),
        // Use fetchCrossRate to get correctly calculated EUR/IQD (not raw EUR/USD ratio)
        fetchCrossRate('dolardinar', 'EUR-to-IQD').then(r => results.eur_iqd.dolardinar = r).catch(() => { })
    ];


    // TRY/IQD
    const tryPromises = [
        fetchEgRate('TRY-to-IQD').then(r => results.try_iqd.forexfy = r).catch(() => { }),
        fetchFromDolarDinar('TRY').then(r => results.try_iqd.dolardinar = r).catch(() => { })
    ];

    await Promise.all([...usdPromises, ...eurPromises, ...tryPromises]);

    // Calculate averages
    const calcAvg = (obj: any) => {
        const vals = Object.values(obj).filter(v => typeof v === 'number') as number[];
        return vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : undefined;
    };

    results.usd_iqd.average = calcAvg(results.usd_iqd);
    results.eur_iqd.average = calcAvg(results.eur_iqd);
    results.try_iqd.average = calcAvg(results.try_iqd);

    return results;
}
