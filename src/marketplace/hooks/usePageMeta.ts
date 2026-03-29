import { useEffect } from 'react'

export function usePageMeta(title: string, description: string) {
    useEffect(() => {
        const previousTitle = document.title
        const metaDescription = document.querySelector('meta[name="description"]')
        const previousDescription = metaDescription?.getAttribute('content')

        document.title = title
        if (metaDescription) {
            metaDescription.setAttribute('content', description)
        }

        return () => {
            document.title = previousTitle
            if (metaDescription && previousDescription != null) {
                metaDescription.setAttribute('content', previousDescription)
            }
        }
    }, [description, title])
}
