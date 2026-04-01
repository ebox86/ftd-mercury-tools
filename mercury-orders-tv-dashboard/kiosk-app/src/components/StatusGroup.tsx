import { OrderCard } from './OrderCard';
import type { BoardCard, StatusStage } from '../lib/types';

interface StatusGroupProps {
  stage: StatusStage;
  label: string;
  cards: BoardCard[];
}

export function StatusGroup({ stage, label, cards }: StatusGroupProps) {
  return (
    <section className="status-group" data-stage={stage}>
      <header className="status-group__header">
        <h2>{label}</h2>
        <span className="status-group__count">{cards.length}</span>
      </header>
      <div className="status-group__list">
        {cards.length === 0 ? (
          <div className="status-group__empty">No orders in this status.</div>
        ) : (
          cards.map(card => <OrderCard key={card.ticketId} card={card} />)
        )}
      </div>
    </section>
  );
}

