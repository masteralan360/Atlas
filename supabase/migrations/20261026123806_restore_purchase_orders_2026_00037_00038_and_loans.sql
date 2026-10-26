-- Restore the two backed-up completed purchase orders and their unpaid simple
-- borrowed loans. The original loan/installment rows were deleted; PO36 provides
-- the matching one-installment, unscheduled loan shape. Since loan timestamps
-- and installment UUIDs were not in the backup, align timestamps to each order's
-- backed-up receipt timestamp and generate new installment UUIDs.
-- No inventory, inventory_transactions, or stock_batches rows are written.
DO $restore_purchase_orders_and_loans$
DECLARE
  v_order_data jsonb := '[{"id":"74608924-fead-4ee7-a3b6-c7b2ce65ecff","items":[{"id":"63dbb0c1-0e42-4b92-9714-4dccb77945f1","note":null,"unit":"carton","uomId":"b0195f30-d96b-4c47-af5e-be5120bec0a6","unitRef":"builtin:carton","quantity":5,"lineTotal":42800,"productId":"4bd948c8-0e60-4168-a58c-66b7c4c2f485","storageId":"97d4e561-4999-44da-aa10-cd0259d21604","productSku":"059717984103","unitFactor":1,"baseUnitRef":"builtin:carton","batchNumber":null,"priceBookId":null,"productName":"ايفني كاتشب80غ12عدد","baseUnitCode":"carton","uomCostPrice":8560,"batchSalePrice":10000,"batchExpiryDate":null,"priceBookItemId":null,"uomNameSnapshot":"carton","originalCurrency":"iqd","receivedQuantity":5,"unitNameSnapshot":"carton","inventoryQuantity":5,"originalUnitPrice":8560,"convertedUnitPrice":8560,"settlementCurrency":"iqd","baseUnitNameSnapshot":"carton","convertedUomCostPrice":8560,"batchManufacturingDate":null,"freeBonusInventoryQuantity":0,"minimumSellingPriceSnapshot":null},{"id":"c6013639-9351-4db7-8fd8-6843d427821f","note":null,"unit":"carton","uomId":"a8f3a685-4da0-484b-ae19-d70218c53890","unitRef":"builtin:carton","quantity":5,"lineTotal":42800,"productId":"8ac9a4d1-e81e-4861-bb08-2837e3054bf6","storageId":"97d4e561-4999-44da-aa10-cd0259d21604","productSku":"239385269492","unitFactor":1,"baseUnitRef":"builtin:carton","batchNumber":null,"priceBookId":null,"productName":"ايفني ليمو 80غ 12عدد","baseUnitCode":"carton","uomCostPrice":8560,"batchSalePrice":10000,"batchExpiryDate":null,"priceBookItemId":null,"uomNameSnapshot":"carton","originalCurrency":"iqd","receivedQuantity":5,"unitNameSnapshot":"carton","inventoryQuantity":5,"originalUnitPrice":8560,"convertedUnitPrice":8560,"settlementCurrency":"iqd","baseUnitNameSnapshot":"carton","convertedUomCostPrice":8560,"batchManufacturingDate":null,"freeBonusInventoryQuantity":0,"minimumSellingPriceSnapshot":null},{"id":"23068bdc-5652-422e-9e93-b2722f0d0681","note":null,"unit":"carton","uomId":"fa97f1a1-0882-439c-b9a4-40c51419cb70","unitRef":"builtin:carton","quantity":5,"lineTotal":42800,"productId":"2ca452d5-9c96-446c-a1d6-a7c6dcd87dc4","storageId":"97d4e561-4999-44da-aa10-cd0259d21604","productSku":"260929363291","unitFactor":1,"baseUnitRef":"builtin:carton","batchNumber":null,"priceBookId":null,"productName":"ايفني حار حلو80غ12عدد","baseUnitCode":"carton","uomCostPrice":8560,"batchSalePrice":10000,"batchExpiryDate":null,"priceBookItemId":null,"uomNameSnapshot":"carton","originalCurrency":"iqd","receivedQuantity":5,"unitNameSnapshot":"carton","inventoryQuantity":5,"originalUnitPrice":8560,"convertedUnitPrice":8560,"settlementCurrency":"iqd","baseUnitNameSnapshot":"carton","convertedUomCostPrice":8560,"batchManufacturingDate":null,"freeBonusInventoryQuantity":0,"minimumSellingPriceSnapshot":null},{"id":"1c24f6a2-b773-4141-9b96-6054398e5f70","note":null,"unit":"carton","uomId":"910e6589-c0c0-4d5c-9dc4-8f5a8e4d1938","unitRef":"builtin:carton","quantity":5,"lineTotal":42800,"productId":"ca2d375d-905e-41eb-86f4-16684f6ce2a2","storageId":"97d4e561-4999-44da-aa10-cd0259d21604","productSku":"525866723288","unitFactor":1,"baseUnitRef":"builtin:carton","batchNumber":null,"priceBookId":null,"productName":"ايفني ملح وخل 80غ 12عدد","baseUnitCode":"carton","uomCostPrice":8560,"batchSalePrice":10000,"batchExpiryDate":null,"priceBookItemId":null,"uomNameSnapshot":"carton","originalCurrency":"iqd","receivedQuantity":5,"unitNameSnapshot":"carton","inventoryQuantity":5,"originalUnitPrice":8560,"convertedUnitPrice":8560,"settlementCurrency":"iqd","baseUnitNameSnapshot":"carton","convertedUomCostPrice":8560,"batchManufacturingDate":null,"freeBonusInventoryQuantity":0,"minimumSellingPriceSnapshot":null},{"id":"22c82c15-3433-42dd-b463-ebb33b277648","note":null,"unit":"carton","uomId":"95610fc5-e2da-4ece-a2e3-d1577041032f","unitRef":"builtin:carton","quantity":5,"lineTotal":42800,"productId":"666c0e53-554c-4b74-835c-cc0bbcd53167","storageId":"97d4e561-4999-44da-aa10-cd0259d21604","productSku":"807288987272","unitFactor":1,"baseUnitRef":"builtin:carton","batchNumber":null,"priceBookId":null,"productName":"ايفني جبنه 80غ12عدد","baseUnitCode":"carton","uomCostPrice":8560,"batchSalePrice":10000,"batchExpiryDate":null,"priceBookItemId":null,"uomNameSnapshot":"carton","originalCurrency":"iqd","receivedQuantity":5,"unitNameSnapshot":"carton","inventoryQuantity":5,"originalUnitPrice":8560,"convertedUnitPrice":8560,"settlementCurrency":"iqd","baseUnitNameSnapshot":"carton","convertedUomCostPrice":8560,"batchManufacturingDate":null,"freeBonusInventoryQuantity":0,"minimumSellingPriceSnapshot":null},{"id":"7e0b6d97-ff7f-4499-a816-0bd01c966162","note":null,"unit":"carton","uomId":"eb5bd67b-05d6-41e7-bb5e-30478bc34e05","unitRef":"builtin:carton","quantity":88,"lineTotal":484000,"productId":"6ff8eadb-d457-46b5-bf26-9a8ab9df8d07","storageId":"97d4e561-4999-44da-aa10-cd0259d21604","productSku":"070041188401","unitFactor":1,"baseUnitRef":"builtin:carton","batchNumber":null,"priceBookId":null,"productName":"شندري زبده35غ40ع","baseUnitCode":"carton","uomCostPrice":5500,"batchSalePrice":7500,"batchExpiryDate":null,"priceBookItemId":null,"uomNameSnapshot":"carton","originalCurrency":"iqd","receivedQuantity":88,"unitNameSnapshot":"carton","inventoryQuantity":88,"originalUnitPrice":5500,"convertedUnitPrice":5500,"settlementCurrency":"iqd","baseUnitNameSnapshot":"carton","convertedUomCostPrice":5500,"batchManufacturingDate":null,"freeBonusInventoryQuantity":0,"minimumSellingPriceSnapshot":null},{"id":"bfe088be-29e2-484f-b033-4602c4166944","note":null,"unit":"carton","uomId":"fa6f7304-70f0-490d-89a9-b55a5d372c97","unitRef":"builtin:carton","quantity":76,"lineTotal":418000,"productId":"c7105863-ee7f-4f03-85d2-234ed52ac256","storageId":"97d4e561-4999-44da-aa10-cd0259d21604","productSku":"352251595027","unitFactor":1,"baseUnitRef":"builtin:carton","batchNumber":null,"priceBookId":null,"productName":"شندري ذره حلوة35غ 40ع","baseUnitCode":"carton","uomCostPrice":5500,"batchSalePrice":7500,"batchExpiryDate":null,"priceBookItemId":null,"uomNameSnapshot":"carton","originalCurrency":"iqd","receivedQuantity":76,"unitNameSnapshot":"carton","inventoryQuantity":76,"originalUnitPrice":5500,"convertedUnitPrice":5500,"settlementCurrency":"iqd","baseUnitNameSnapshot":"carton","convertedUomCostPrice":5500,"batchManufacturingDate":null,"freeBonusInventoryQuantity":0,"minimumSellingPriceSnapshot":null},{"id":"a64ca35e-2dbb-49fc-afac-0c1e60bcdbb5","note":null,"unit":"carton","uomId":"e4b8b7b6-90f2-4a2f-a2c9-be4d395c30da","unitRef":"builtin:carton","quantity":48,"lineTotal":264000,"productId":"da252cd4-a3e0-420c-b58a-dcdae7529fa6","storageId":"97d4e561-4999-44da-aa10-cd0259d21604","productSku":"068584917893","unitFactor":1,"baseUnitRef":"builtin:carton","batchNumber":null,"priceBookId":null,"productName":"شندري35غ 40ع","baseUnitCode":"carton","uomCostPrice":5500,"batchSalePrice":7500,"batchExpiryDate":null,"priceBookItemId":null,"uomNameSnapshot":"carton","originalCurrency":"iqd","receivedQuantity":48,"unitNameSnapshot":"carton","inventoryQuantity":48,"originalUnitPrice":5500,"convertedUnitPrice":5500,"settlementCurrency":"iqd","baseUnitNameSnapshot":"carton","convertedUomCostPrice":5500,"batchManufacturingDate":null,"freeBonusInventoryQuantity":0,"minimumSellingPriceSnapshot":null},{"id":"fedf952f-5719-4f0b-89c0-866eeac61b52","note":null,"unit":"carton","uomId":"a4ff8d5b-9352-413f-9e5a-88fe16df1280","unitRef":"builtin:carton","quantity":48,"lineTotal":264000,"productId":"039be3cb-da03-415b-94ac-db9fd39dd131","storageId":"97d4e561-4999-44da-aa10-cd0259d21604","productSku":"604836196557","unitFactor":1,"baseUnitRef":"builtin:carton","batchNumber":null,"priceBookId":null,"productName":"شندري جبنه35غ 40ع","baseUnitCode":"carton","uomCostPrice":5500,"batchSalePrice":7500,"batchExpiryDate":null,"priceBookItemId":null,"uomNameSnapshot":"carton","originalCurrency":"iqd","receivedQuantity":48,"unitNameSnapshot":"carton","inventoryQuantity":48,"originalUnitPrice":5500,"convertedUnitPrice":5500,"settlementCurrency":"iqd","baseUnitNameSnapshot":"carton","convertedUomCostPrice":5500,"batchManufacturingDate":null,"freeBonusInventoryQuantity":0,"minimumSellingPriceSnapshot":null}],"notes":null,"total":1644000,"status":"completed","is_paid":false,"paid_at":null,"version":4,"currency":"iqd","discount":0,"subtotal":1644000,"is_locked":false,"created_at":"2026-10-17T19:53:01.346+03:00","created_by":"ed2e7a73-1641-4a9d-a9c1-b9a1919e641b","is_deleted":false,"updated_at":"2026-10-17T20:04:40.54881+03:00","is_archived":false,"paid_amount":0,"supplier_id":"2ec4aa21-db57-4a64-a953-f7e46d936d21","sync_status":"synced","order_number":"PO-2026-00037","workspace_id":"0b342f6c-bcdc-45a9-bcda-9d21360ff3c9","exchange_rate":null,"next_due_date":null,"supplier_name":"جريت فود","balance_amount":1644000,"exchange_rates":null,"first_due_date":null,"linked_loan_id":"a9056057-0e1b-46bf-be5d-6b7e11574990","payment_method":"loan","payment_status":"unpaid","approval_status":null,"installment_count":0,"order_adjustments":null,"business_partner_id":"96148f06-1381-4aec-a884-150fe19cca77","actual_delivery_date":"2026-10-17T20:04:37.178025+03:00","approval_reviewed_at":null,"approval_reviewed_by":null,"exchange_rate_source":null,"is_installment_based":false,"approval_requested_at":null,"approval_requested_by":null,"installment_frequency":"monthly","destination_storage_id":"97d4e561-4999-44da-aa10-cd0259d21604","expected_delivery_date":null,"initial_payment_amount":0,"exchange_rate_timestamp":null,"initial_payment_account_id":null,"initial_payment_account_name_snapshot":null},{"id":"69fd678b-0330-4f8c-bae1-bf79ee2d081e","items":[{"id":"e543ea09-80e3-4c7e-b677-794639629410","note":null,"unit":"carton","uomId":"eb5bd67b-05d6-41e7-bb5e-30478bc34e05","unitRef":"builtin:carton","quantity":42,"lineTotal":231000,"productId":"6ff8eadb-d457-46b5-bf26-9a8ab9df8d07","storageId":"97d4e561-4999-44da-aa10-cd0259d21604","productSku":"070041188401","unitFactor":1,"baseUnitRef":"builtin:carton","batchNumber":null,"priceBookId":null,"productName":"شندري زبده35غ40ع","baseUnitCode":"carton","uomCostPrice":5500,"batchSalePrice":7500,"batchExpiryDate":null,"priceBookItemId":null,"uomNameSnapshot":"carton","originalCurrency":"iqd","receivedQuantity":42,"unitNameSnapshot":"carton","inventoryQuantity":42,"originalUnitPrice":5500,"convertedUnitPrice":5500,"settlementCurrency":"iqd","baseUnitNameSnapshot":"carton","convertedUomCostPrice":5500,"batchManufacturingDate":null,"freeBonusInventoryQuantity":0,"minimumSellingPriceSnapshot":null},{"id":"c05c2c37-b379-44cf-a76c-67a7da9b531a","note":null,"unit":"carton","uomId":"fa6f7304-70f0-490d-89a9-b55a5d372c97","unitRef":"builtin:carton","quantity":55,"lineTotal":302500,"productId":"c7105863-ee7f-4f03-85d2-234ed52ac256","storageId":"97d4e561-4999-44da-aa10-cd0259d21604","productSku":"352251595027","unitFactor":1,"baseUnitRef":"builtin:carton","batchNumber":null,"priceBookId":null,"productName":"شندري ذره حلوة35غ 40ع","baseUnitCode":"carton","uomCostPrice":5500,"batchSalePrice":7500,"batchExpiryDate":null,"priceBookItemId":null,"uomNameSnapshot":"carton","originalCurrency":"iqd","receivedQuantity":55,"unitNameSnapshot":"carton","inventoryQuantity":55,"originalUnitPrice":5500,"convertedUnitPrice":5500,"settlementCurrency":"iqd","baseUnitNameSnapshot":"carton","convertedUomCostPrice":5500,"batchManufacturingDate":null,"freeBonusInventoryQuantity":0,"minimumSellingPriceSnapshot":null},{"id":"ba6681ed-006c-46e9-9719-d8c705f40f24","note":null,"unit":"carton","uomId":"e4b8b7b6-90f2-4a2f-a2c9-be4d395c30da","unitRef":"builtin:carton","quantity":83,"lineTotal":456500,"productId":"da252cd4-a3e0-420c-b58a-dcdae7529fa6","storageId":"97d4e561-4999-44da-aa10-cd0259d21604","productSku":"068584917893","unitFactor":1,"baseUnitRef":"builtin:carton","batchNumber":null,"priceBookId":null,"productName":"شندري35غ 40ع","baseUnitCode":"carton","uomCostPrice":5500,"batchSalePrice":7500,"batchExpiryDate":null,"priceBookItemId":null,"uomNameSnapshot":"carton","originalCurrency":"iqd","receivedQuantity":83,"unitNameSnapshot":"carton","inventoryQuantity":83,"originalUnitPrice":5500,"convertedUnitPrice":5500,"settlementCurrency":"iqd","baseUnitNameSnapshot":"carton","convertedUomCostPrice":5500,"batchManufacturingDate":null,"freeBonusInventoryQuantity":0,"minimumSellingPriceSnapshot":null},{"id":"3f27d8d3-9eeb-4768-92a3-e32d57cc2cf7","note":null,"unit":"carton","uomId":"a4ff8d5b-9352-413f-9e5a-88fe16df1280","unitRef":"builtin:carton","quantity":83,"lineTotal":456500,"productId":"039be3cb-da03-415b-94ac-db9fd39dd131","storageId":"97d4e561-4999-44da-aa10-cd0259d21604","productSku":"604836196557","unitFactor":1,"baseUnitRef":"builtin:carton","batchNumber":null,"priceBookId":null,"productName":"شندري جبنه35غ 40ع","baseUnitCode":"carton","uomCostPrice":5500,"batchSalePrice":7500,"batchExpiryDate":null,"priceBookItemId":null,"uomNameSnapshot":"carton","originalCurrency":"iqd","receivedQuantity":83,"unitNameSnapshot":"carton","inventoryQuantity":83,"originalUnitPrice":5500,"convertedUnitPrice":5500,"settlementCurrency":"iqd","baseUnitNameSnapshot":"carton","convertedUomCostPrice":5500,"batchManufacturingDate":null,"freeBonusInventoryQuantity":0,"minimumSellingPriceSnapshot":null}],"notes":null,"total":1446500,"status":"completed","is_paid":false,"paid_at":null,"version":4,"currency":"iqd","discount":0,"subtotal":1446500,"is_locked":false,"created_at":"2026-10-18T10:22:56.709+03:00","created_by":"ed2e7a73-1641-4a9d-a9c1-b9a1919e641b","is_deleted":false,"updated_at":"2026-10-18T10:25:25.62083+03:00","is_archived":false,"paid_amount":0,"supplier_id":"2ec4aa21-db57-4a64-a953-f7e46d936d21","sync_status":"synced","order_number":"PO-2026-00038","workspace_id":"0b342f6c-bcdc-45a9-bcda-9d21360ff3c9","exchange_rate":null,"next_due_date":null,"supplier_name":"جريت فود","balance_amount":1446500,"exchange_rates":null,"first_due_date":null,"linked_loan_id":"35b9c02c-825b-4b6a-9812-e99edfda579e","payment_method":"loan","payment_status":"unpaid","approval_status":null,"installment_count":0,"order_adjustments":null,"business_partner_id":"96148f06-1381-4aec-a884-150fe19cca77","actual_delivery_date":"2026-10-18T10:25:08.995741+03:00","approval_reviewed_at":null,"approval_reviewed_by":null,"exchange_rate_source":null,"is_installment_based":false,"approval_requested_at":null,"approval_requested_by":null,"installment_frequency":"monthly","destination_storage_id":"97d4e561-4999-44da-aa10-cd0259d21604","expected_delivery_date":null,"initial_payment_amount":0,"exchange_rate_timestamp":null,"initial_payment_account_id":null,"initial_payment_account_name_snapshot":null}]'::jsonb;
  v_order jsonb;
  v_loan_id uuid;
  v_loan_no text;
  v_created_at timestamptz;
  v_row_count integer;
  v_inventory_hash text;
  v_batch_hash text;
  v_transaction_hash text;
BEGIN
  IF jsonb_array_length(v_order_data) <> 2
    OR ARRAY(
      SELECT value->>'order_number'
      FROM jsonb_array_elements(v_order_data)
      ORDER BY value->>'order_number'
    ) IS DISTINCT FROM ARRAY['PO-2026-00037', 'PO-2026-00038']::text[]
  THEN
    RAISE EXCEPTION 'Restore payload does not contain exactly the two expected purchase orders';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_order_data) AS expected(value)
    JOIN crm.purchase_orders AS existing
      ON existing.id = (expected.value->>'id')::uuid
      OR (
        existing.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
        AND existing.order_number = expected.value->>'order_number'
      )
  ) THEN
    RAISE EXCEPTION 'A purchase order ID or order number already exists; refusing to duplicate it';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.loans AS loan
    WHERE loan.id = ANY (ARRAY[
      'a9056057-0e1b-46bf-be5d-6b7e11574990'::uuid,
      '35b9c02c-825b-4b6a-9812-e99edfda579e'::uuid
    ])
      OR (
        loan.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
        AND loan.loan_no = ANY (ARRAY[
          'SL-20261017-A90560',
          'SL-20261018-35B9C0'
        ]::text[])
      )
  ) THEN
    RAISE EXCEPTION 'A linked loan ID or loan number already exists; refusing to duplicate it';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.loan_payments
    WHERE loan_id = ANY (ARRAY[
      'a9056057-0e1b-46bf-be5d-6b7e11574990'::uuid,
      '35b9c02c-825b-4b6a-9812-e99edfda579e'::uuid
    ])
  ) OR EXISTS (
    SELECT 1 FROM public.payment_transactions
    WHERE workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
      AND source_record_id = ANY (ARRAY[
        'a9056057-0e1b-46bf-be5d-6b7e11574990'::uuid,
        '35b9c02c-825b-4b6a-9812-e99edfda579e'::uuid
      ])
  ) THEN
    RAISE EXCEPTION 'Unexpected loan payment history exists; refusing to recreate partial loan history';
  END IF;

  -- Use the original creator's workspace context for existing order validation
  -- triggers. The database migration itself remains privileged.
  PERFORM set_config('request.jwt.claim.sub', 'ed2e7a73-1641-4a9d-a9c1-b9a1919e641b', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', 'ed2e7a73-1641-4a9d-a9c1-b9a1919e641b',
      'role', 'service_role'
    )::text,
    true
  );

  FOR v_order IN
    SELECT value
    FROM jsonb_array_elements(v_order_data)
    ORDER BY value->>'order_number'
  LOOP
    IF v_order->>'payment_method' IS DISTINCT FROM 'loan'
      OR (v_order->>'linked_loan_id') IS NULL
      OR (v_order->>'paid_amount')::numeric <> 0
      OR (v_order->>'balance_amount')::numeric IS DISTINCT FROM (v_order->>'total')::numeric
    THEN
      RAISE EXCEPTION 'Purchase order % is not in the expected unpaid loan state',
        v_order->>'order_number';
    END IF;

    -- The receipt guard requires this transaction-local order binding. It does
    -- not call the receipt RPC, which would touch stock.
    PERFORM set_config('atlas.purchase_receipt_order_id', v_order->>'id', true);

    -- Avoid the order-number allocator rewriting the historical number on
    -- insert, then restore the backed-up number immediately after both rows
    -- exist. This changes only the crm.purchase_orders rows.
    INSERT INTO crm.purchase_orders
    SELECT (
      jsonb_populate_record(
        NULL::crm.purchase_orders,
        v_order || jsonb_build_object(
          'order_number',
          'RESTORE-' || (v_order->>'order_number')
        )
      )
    ).*;
  END LOOP;

  UPDATE crm.purchase_orders AS purchase_order
  SET order_number = expected.value->>'order_number'
  FROM jsonb_array_elements(v_order_data) AS expected(value)
  WHERE purchase_order.id = (expected.value->>'id')::uuid
    AND purchase_order.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count <> 2 THEN
    RAISE EXCEPTION 'Expected to restore two original purchase order numbers; updated %', v_row_count;
  END IF;

  FOR v_order IN
    SELECT value
    FROM jsonb_array_elements(v_order_data)
    ORDER BY value->>'order_number'
  LOOP
    v_loan_id := (v_order->>'linked_loan_id')::uuid;
    v_created_at := COALESCE(
      NULLIF(v_order->>'actual_delivery_date', '')::timestamptz,
      (v_order->>'created_at')::timestamptz
    );
    v_loan_no := CASE v_order->>'order_number'
      WHEN 'PO-2026-00037' THEN 'SL-20261017-A90560'
      WHEN 'PO-2026-00038' THEN 'SL-20261018-35B9C0'
      ELSE NULL
    END;

    IF v_loan_id IS NULL OR v_loan_no IS NULL OR v_created_at IS NULL THEN
      RAISE EXCEPTION 'Could not resolve the original loan identity or restore timestamp for %',
        v_order->>'order_number';
    END IF;

    INSERT INTO public.loans (
      id, workspace_id, sale_id, order_id, order_type, loan_no, source,
      borrower_name, borrower_phone, borrower_address, borrower_national_id,
      principal_amount, total_paid_amount, balance_amount, settlement_currency,
      installment_count, installment_frequency, first_due_date, next_due_date,
      status, notes, created_by, created_at, updated_at, version, is_deleted,
      overdue_reminder_snoozed_at, overdue_reminder_snoozed_for_due_date,
      linked_party_type, linked_party_id, linked_party_name,
      loan_category, direction, exchange_rate_snapshot,
      origination_transaction_id, terms_locked_at, integrity_version
    )
    VALUES (
      v_loan_id,
      (v_order->>'workspace_id')::uuid,
      NULL,
      (v_order->>'id')::uuid,
      'purchase',
      v_loan_no,
      'order',
      COALESCE(v_order->>'supplier_name', ''),
      '',
      '',
      '',
      (v_order->>'total')::numeric,
      0,
      (v_order->>'balance_amount')::numeric,
      lower(v_order->>'currency'),
      1,
      COALESCE(v_order->>'installment_frequency', 'monthly'),
      NULL,
      NULL,
      'active',
      'Financing for purchase order ' || (v_order->>'order_number'),
      NULLIF(v_order->>'created_by', '')::uuid,
      v_created_at,
      v_created_at,
      1,
      false,
      NULL,
      NULL,
      'business_partner',
      NULLIF(v_order->>'business_partner_id', '')::uuid,
      COALESCE(v_order->>'supplier_name', ''),
      'simple',
      'borrowed',
      NULL,
      NULL,
      v_created_at,
      1
    );

    INSERT INTO public.loan_installments (
      id, loan_id, workspace_id, installment_no, due_date,
      planned_amount, paid_amount, balance_amount, status, paid_at,
      created_at, updated_at, version, is_deleted, integrity_version
    )
    VALUES (
      gen_random_uuid(),
      v_loan_id,
      (v_order->>'workspace_id')::uuid,
      1,
      NULL,
      (v_order->>'total')::numeric,
      0,
      (v_order->>'total')::numeric,
      'unpaid',
      NULL,
      v_created_at,
      v_created_at,
      1,
      false,
      1
    );
  END LOOP;

  IF (
    SELECT count(*) FROM crm.purchase_orders
    WHERE workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
      AND order_number = ANY (ARRAY['PO-2026-00037', 'PO-2026-00038']::text[])
      AND id = ANY (ARRAY[
        '74608924-fead-4ee7-a3b6-c7b2ce65ecff'::uuid,
        '69fd678b-0330-4f8c-bae1-bf79ee2d081e'::uuid
      ])
  ) <> 2 OR (
    SELECT count(*) FROM public.loans
    WHERE workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
      AND id = ANY (ARRAY[
        'a9056057-0e1b-46bf-be5d-6b7e11574990'::uuid,
        '35b9c02c-825b-4b6a-9812-e99edfda579e'::uuid
      ])
      AND status = 'active'
      AND total_paid_amount = 0
      AND balance_amount = principal_amount
  ) <> 2 OR (
    SELECT count(*) FROM public.loan_installments
    WHERE loan_id = ANY (ARRAY[
      'a9056057-0e1b-46bf-be5d-6b7e11574990'::uuid,
      '35b9c02c-825b-4b6a-9812-e99edfda579e'::uuid
    ])
      AND status = 'unpaid'
      AND planned_amount = balance_amount
      AND paid_amount = 0
  ) <> 2 THEN
    RAISE EXCEPTION 'Restored order, loan, or installment verification failed';
  END IF;

  -- Guard the user's explicit no-stock-change requirement with exact snapshots.
  WITH target_items AS (
    SELECT DISTINCT
      NULLIF(item.value->>'productId', '')::uuid AS product_id,
      COALESCE(
        NULLIF(item.value->>'storageId', '')::uuid,
        NULLIF(order_row.value->>'destination_storage_id', '')::uuid
      ) AS storage_id
    FROM jsonb_array_elements(v_order_data) AS order_row(value)
    CROSS JOIN LATERAL jsonb_array_elements(order_row.value->'items') AS item(value)
  )
  SELECT md5(COALESCE((
    SELECT jsonb_agg(to_jsonb(inventory_row) ORDER BY inventory_row.product_id, inventory_row.storage_id)::text
    FROM public.inventory AS inventory_row
    JOIN target_items ON target_items.product_id = inventory_row.product_id
      AND target_items.storage_id = inventory_row.storage_id
    WHERE inventory_row.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
  ), '[]'))
  INTO v_inventory_hash;

  SELECT md5(COALESCE((
    SELECT jsonb_agg(to_jsonb(batch_row) ORDER BY batch_row.id)::text
    FROM public.stock_batches AS batch_row
    WHERE batch_row.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
      AND batch_row.source_purchase_order_id = ANY (ARRAY[
        '74608924-fead-4ee7-a3b6-c7b2ce65ecff'::uuid,
        '69fd678b-0330-4f8c-bae1-bf79ee2d081e'::uuid
      ])
  ), '[]'))
  INTO v_batch_hash;

  SELECT md5(COALESCE((
    SELECT jsonb_agg(to_jsonb(transaction_row) ORDER BY transaction_row.id)::text
    FROM public.inventory_transactions AS transaction_row
    WHERE transaction_row.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
      AND transaction_row.reference_id = ANY (ARRAY[
        '74608924-fead-4ee7-a3b6-c7b2ce65ecff',
        '69fd678b-0330-4f8c-bae1-bf79ee2d081e'
      ]::text[])
  ), '[]'))
  INTO v_transaction_hash;

  IF v_inventory_hash IS DISTINCT FROM 'd48c5c11bcd3d93e0116a0d1259d177e'
    OR v_batch_hash IS DISTINCT FROM '108bd77134c24492023c04bfcbfe6a33'
    OR v_transaction_hash IS DISTINCT FROM '02a39c40d362f6ce5bf3c0e865eab0c2'
  THEN
    RAISE EXCEPTION
      'Stock safeguard failed; inventory %, batches %, purchase transactions %',
      v_inventory_hash, v_batch_hash, v_transaction_hash;
  END IF;
END
$restore_purchase_orders_and_loans$;