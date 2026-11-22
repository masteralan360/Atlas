import { useState, useEffect } from "react";
import i18n from "@/i18n/config";
import { getLanguageDirection, parseLangFromHash, getPathWithLang } from "@/lib/i18nRouting";

const currentLoc = () => {
    const hash = window.location.hash.replace(/^#/, "") || "/";
    const { path } = parseLangFromHash(hash);
    return path;
};

export const useHashLocation = () => {
    const [loc, setLoc] = useState(currentLoc());

    useEffect(() => {
        const handler = () => {
            setLoc(currentLoc());

            const hash = window.location.hash.replace(/^#/, "") || "/";
            const { lang } = parseLangFromHash(hash);
            if (lang && lang !== i18n.language) {
                i18n.changeLanguage(lang);
                localStorage.setItem("i18nextLng", lang);
                const dir = getLanguageDirection(lang);
                document.dir = dir;
                document.documentElement.dir = dir;
                document.documentElement.lang = lang;
            }
        };

        window.addEventListener("hashchange", handler);
        handler();
        return () => window.removeEventListener("hashchange", handler);
    }, []);

    const navigate = (to: string) => {
        window.location.hash = getPathWithLang(to, i18n.language);
    };

    return [loc, navigate] as [string, (to: string) => void];
};
