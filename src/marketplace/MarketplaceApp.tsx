import { Redirect, Route, Switch } from 'wouter'

import { MarketplaceGallery } from './pages/MarketplaceGallery'
import { StorePage } from './pages/StorePage'

export function MarketplaceApp() {
    return (
        <Switch>
            <Route path="/s/:slug">
                <StorePage />
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
