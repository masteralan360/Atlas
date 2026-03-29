import { Redirect, Route, Switch } from 'wouter'

import { MarketplaceGallery } from './pages/MarketplaceGallery'
import { StorePage } from './pages/StorePage'

export function MarketplaceApp() {
    return (
        <Switch>
            <Route path="/marketplace/s/:slug">
                <StorePage />
            </Route>
            <Route path="/marketplace">
                <MarketplaceGallery />
            </Route>
            <Route path="/">
                <Redirect to="/marketplace" />
            </Route>
            <Route>
                <Redirect to="/marketplace" />
            </Route>
        </Switch>
    )
}
