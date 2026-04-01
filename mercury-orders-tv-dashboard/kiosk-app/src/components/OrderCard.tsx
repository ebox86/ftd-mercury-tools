import type { BoardCard } from '../lib/types';

interface OrderCardProps {
  card: BoardCard;
}

export function OrderCard({ card }: OrderCardProps) {
  return (
    <article className="order-card">
      <header className="order-card__header">
        <span className="order-card__ref">{card.userReference || card.ticketId}</span>
        <span className="order-card__type">{card.orderType || 'Order'}</span>
      </header>
      <div className="order-card__name">{card.recipientName || 'Unknown Recipient'}</div>
      <div className="order-card__address">{card.addressLine || 'No street address'}</div>
      <div className="order-card__city">{card.cityStateZip || 'No city/state/zip'}</div>
      <div className="order-card__status-grid">
        <span className="order-card__status-label">Design</span>
        <span className="order-card__status-value">{card.designStatus || 'Unknown'}</span>
        <span className="order-card__status-label">Delivery</span>
        <span className="order-card__status-value">{card.deliveryStatus || 'Unknown'}</span>
      </div>
      <footer className="order-card__footer">
        <span>{card.deliveryDate || 'No delivery date'}</span>
        <span className="order-card__reason">{card.stageReason}</span>
      </footer>
    </article>
  );
}
