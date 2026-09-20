import { describe, expect, it } from 'vitest'

import { requestHeadersForUpstream } from '../api/_workspaceUsage.js'

describe('Vercel workspace R2 gateway', () => {
  it('forwards the complete Atlas compressed-image contract', () => {
    const headers = requestHeadersForUpstream({
      headers: {
        authorization: 'Bearer token',
        'content-type': 'image/webp',
        'x-atlas-image-compressed': '1',
        'x-atlas-image-source': 'workspace-logo',
        'x-atlas-image-profile': '1',
        'x-atlas-image-width': '512',
        'x-atlas-image-height': '256',
        'x-atlas-image-original-bytes': '100000',
      },
    }, Buffer.from('webp'))

    expect(Object.fromEntries(headers.entries())).toMatchObject({
      authorization: 'Bearer token',
      'content-type': 'image/webp',
      'x-atlas-image-compressed': '1',
      'x-atlas-image-source': 'workspace-logo',
      'x-atlas-image-profile': '1',
      'x-atlas-image-width': '512',
      'x-atlas-image-height': '256',
      'x-atlas-image-original-bytes': '100000',
    })
  })
})
