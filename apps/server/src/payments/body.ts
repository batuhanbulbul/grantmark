import type { LicenseRequest } from '../olp/licenses';
import { PAYMENT_TIMEOUT_SECONDS } from './service';
import type { StoredPayment } from './store';

/**
 * The payment as clients see it. `accepts` follows x402's field names (CAIP-2 network, asset,
 * amount in base units, pay-to, memo, timeout) so an x402 adapter can be added without changing
 * clients; it lists an option only while the payment can still be made.
 */
export function paymentBody(payment: StoredPayment, request: LicenseRequest) {
  const r = payment.request;
  const payable = payment.status === 'requires_payment' || payment.status === 'processing';
  return {
    id: payment.id,
    license_request: payment.licenseRequestId,
    status: payment.status,
    amount: request.amount,
    expires_at: payment.expiresAt.toISOString(),
    ...(payment.reason === undefined ? {} : { reason: payment.reason }),
    ...(payment.externalRef === undefined ? {} : { transaction_signature: payment.externalRef }),
    accepts: payable
      ? [
          {
            provider: r.provider,
            scheme: 'exact',
            network: r.network,
            asset: r.asset,
            amount: r.amount.amountMinor,
            pay_to: r.splits.map((s) => ({ role: s.role, wallet: s.wallet, token_account: s.tokenAccount, amount: s.amount })),
            memo: r.memo,
            transaction: r.transaction,
            last_valid_block_height: r.lastValidBlockHeight,
            max_timeout_seconds: PAYMENT_TIMEOUT_SECONDS,
          },
        ]
      : [],
  };
}
