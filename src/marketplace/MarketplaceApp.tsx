import { Redirect, Route, Switch, useRoute } from 'wouter'

import { MarketplaceGallery } from './pages/MarketplaceGallery'
import { getStorefrontTemplateForSlug } from './templates/registry'

function StorefrontShopRoute() {
    const [, params] = useRoute('/s/:slug')
    const slug = params?.slug || ''
    const { template, options, rules } = getStorefrontTemplateForSlug(slug)
    const Page = template.ShopPage

    return <Page slug={slug} options={options} rules={rules} />
}

function StorefrontContactRoute() {
    const [, params] = useRoute('/s/:slug/contact')
    const slug = params?.slug || ''
    const { template, options, rules } = getStorefrontTemplateForSlug(slug)
    const Page = template.ContactPage

    return <Page slug={slug} options={options} rules={rules} />
}

export function MarketplaceApp() {
    return (
        <Switch>
            <Route path="/s/:slug/contact">
                <StorefrontContactRoute />
            </Route>
            <Route path="/s/:slug">
                <StorefrontShopRoute />
            </Route>
            {/* Vite serves the marketplace entry at /marketplace in local development. */}
            <Route path="/marketplace">
                <MarketplaceGallery />
            </Route>
            <Route path="/">
                <MarketplaceGallery />
            </Route>
            <Route>
                <Redirect to="/" />
            </Route>
        </Switch>
    )
}
