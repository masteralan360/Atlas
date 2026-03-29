import { Redirect, Route, Switch } from 'wouter'

import { MarketplaceGallery } from './pages/MarketplaceGallery'
import { StorePage } from './pages/StorePage'

export function MarketplaceApp() {
    return (
        <Switch>
            <Route path="/marketplace">
                <MarketplaceGallery />
            </Route>
            <Route path="/s/:slug">
                <StorePage />
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
