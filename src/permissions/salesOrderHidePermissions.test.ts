import { describe, expect, it } from 'vitest'

import {
    getAllowedSalesOrderPaymentMethods,
    getMaximumSalesOrderStatus,
    getSalesOrderMaxStatusPermissionKey,
    getSalesOrderPaymentMethodHidePermissionKey,
    getProhibitedSalesOrderPaymentMethods,
    isSalesOrderPaymentMethodAllowed,
    isSalesOrderStatusAllowed,
} from './salesOrderHidePermissions'
import {
    SALES_ORDER_PERMISSION_PAYMENT_METHODS,
    isSupportedWorkspacePermissionKey,
} from './workspacePermissionDefinitions'

describe('Sales Order hide permissions', () => {
    it('derives its supported method set from the Sales Order method definitions', () => {
        expect(SALES_ORDER_PERMISSION_PAYMENT_METHODS).toEqual([
            'cash', 'fib', 'qicard', 'zaincash', 'fastpay', 'bank_transfer', 'loan', 'installments',
        ])
        expect(isSupportedWorkspacePermissionKey('orders.salesOrderPaymentMethod.banktransfer')).toBe(true)
        expect(isSupportedWorkspacePermissionKey('payments.salesOrderPaymentMethod.cash')).toBe(false)
        expect(getSalesOrderPaymentMethodHidePermissionKey('bank_transfer'))
            .toBe('orders.salesOrderPaymentMethod.banktransfer')
    })

    it('keeps legacy access by default and hides only individually prohibited methods', () => {
        const permissionKeys = new Set([
            getSalesOrderPaymentMethodHidePermissionKey('loan'),
        ])

        expect(isSalesOrderPaymentMethodAllowed('cash', new Set())).toBe(true)
        expect(isSalesOrderPaymentMethodAllowed('loan', permissionKeys)).toBe(false)
        expect(getProhibitedSalesOrderPaymentMethods(permissionKeys)).toEqual(['loan'])
        expect(getAllowedSalesOrderPaymentMethods(permissionKeys)).not.toContain('loan')
        expect(getAllowedSalesOrderPaymentMethods(permissionKeys)).toContain('cash')
    })

    it('resolves the maximum status hierarchically and defaults to completed', () => {
        expect(getMaximumSalesOrderStatus(new Set())).toBe('completed')

        const pendingMaximum = new Set([getSalesOrderMaxStatusPermissionKey('pending')])
        expect(isSalesOrderStatusAllowed('draft', pendingMaximum)).toBe(true)
        expect(isSalesOrderStatusAllowed('pending', pendingMaximum)).toBe(true)
        expect(isSalesOrderStatusAllowed('completed', pendingMaximum)).toBe(false)

        const inconsistentKeys = new Set([
            getSalesOrderMaxStatusPermissionKey('pending'),
            getSalesOrderMaxStatusPermissionKey('completed'),
        ])
        expect(getMaximumSalesOrderStatus(inconsistentKeys)).toBe('pending')
    })
})
