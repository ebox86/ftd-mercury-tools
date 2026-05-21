export type StatusStage =
  | 'incoming'
  | 'queued_not_designed'
  | 'designed'
  | 'saved_or_staged'
  | 'on_truck'
  | 'delivered_or_exception';

export interface OrderItem {
  CATEGORY: string;
  ID: string;
  USER_REFERENCE: string;
  SUMMARY_TEXT: string;
  SALE_ID: string;
  TICKET_POSITION: string;
  ORDER_TYPE: string;
  RECIPIENT_NAME: string;
  RECIPIENT_ADDRESS: string;
  RECIPIENT_CITY: string;
  RECIPIENT_STATE: string;
  RECIPIENT_STATE_ABBREV: string;
  RECIPIENT_ZIP: string;
  RECIPIENT_PHONE?: string;
  DELIVERY_DATE: string;
  DELIVERY_INST?: string;
  SPECIAL_INST?: string;
  CC_AMOUNT?: string;
}

export interface MessageItem {
  CATEGORY?: string;
  ID?: string;
  TICKET_NUM?: string;
  ORDER_ID?: string;
  USER_REFERENCE?: string;
  SALE_ID?: string;
  WIRE_SERVICE?: string;
  MSG_TYPE?: string;
  SUMMARY_TEXT?: string;
  MSG_DIRECTION?: string;
  RECIPIENT_NAME?: string;
  RECIPIENT_ADDRESS?: string;
  RECIPIENT_CITY?: string;
  RECIPIENT_STATE?: string;
  RECIPIENT_STATE_ABBREV?: string;
  RECIPIENT_ZIP?: string;
  RECIPIENT_PHONE?: string;
  FIRM_NAME?: string;
  MSG_DATE?: string;
  DELIVERY_DATE?: string;
  SHOP_CODE?: string;
  SHOP_NAME?: string;
  SHOP_PHONE?: string;
  MSG_NOTES?: string;
  MERCURY_NUM?: string;
  CC_AMOUNT?: string;
  REQUIRES_ATTENTION?: string;
}

export interface DashboardEventsDataset {
  dataset: string;
  tables: {
    OrderItems: OrderItem[];
    MessageItems?: MessageItem[];
  };
}

export interface TicketStatusRow {
  DesignerStatus?: string;
  DeliveryStatus?: string;
  DeliveryDate?: string;
  DeliveryRoute?: string;
  DeliveryDriver?: string;
}

export interface TicketStatusDataset {
  dataset: string;
  tables: {
    GetTicketStatus: TicketStatusRow[];
  };
}

export interface OrderDetailsRow {
  ID?: string;
  SALE_ID?: string;
  TICKET_POSITION?: string;
  USER_REFERENCE?: string;
  ORDER_TYPE?: string;
  RECIPIENT_NAME?: string;
  SUMMARY_TEXT?: string;
  DELIVERY_DATE?: string;
}

export interface OrderDetailsDataset {
  dataset?: string;
  tables?: {
    LoadOrderDetails?: OrderDetailsRow[];
  };
  rows?: OrderDetailsRow[];
}

export interface LifecycleRow {
  TICKET_ID?: string;
  SERVICE_MSG_NUM?: string;
  STATUS_CD?: string;
  STATUS_CD_DESC?: string;
  STATUS_TEXT?: string;
  MSG_DATETIME?: string;
}

export interface LifecycleDataset {
  dataset: string;
  tables: {
    OLCStatusMsg: LifecycleRow[];
  };
}

export interface DeliveryOrderByZoneRow {
  ID?: string;
  INVOICE_NO?: string;
  SALE_ID?: string;
  TICKET_POSITION?: string;
  RECIPIENT_NAME?: string;
  RECIPIENT_ADDRESS?: string;
  RECIPIENT_CITY?: string;
  RECIPIENT_STATE_ABBREV?: string;
  RECIPIENT_ZIP?: string;
  ZONE_ID?: string;
  ZONE_NAME?: string;
  PRIORITY_ID?: string;
  PRIORITY_NAME?: string;
  ROUTE_NAME?: string;
  DELIVERY_DATE?: string;
  DESIGNED_IND?: string;
  STATUS?: string;
  LATITUDE?: string;
  LONGITUDE?: string;
  USER_REFERENCE?: string;
}

export interface DeliveryOrdersByZoneDataset {
  dataset?: string;
  table?: string;
  rows?: DeliveryOrderByZoneRow[];
}

export interface DeliveryOrderByRouteRow {
  ID?: string;
  SALE_ID?: string;
  TICKET_POSITION?: string;
  RECIPIENT_NAME?: string;
  RECIPIENT_ADDRESS?: string;
  RECIPIENT_CITY?: string;
  RECIPIENT_STATE_ABBREV?: string;
  RECIPIENT_ZIP?: string;
  ROUTE_ID?: string;
  ROUTE_NAME?: string;
  DRIVER_NAME?: string;
  STOP_SEQ?: string;
  DELIVERY_DATE?: string;
  STATUS?: string;
}

export interface DeliveryOrdersByRoutesDataset {
  dataset?: string;
  table?: string;
  rows?: DeliveryOrderByRouteRow[];
}

export interface TicketSearchRow {
  ID?: string;
  SALE_ID?: string;
  TICKET_POSITION?: string;
  USER_REFERENCE?: string;
  SALE_STATUS_ID?: string;
  ORDER_STATUS?: string;
  ORDER_TYPE?: string;
  RECIPIENT_NAME?: string;
  RECIPIENT_ADDRESS?: string;
  RECIPIENT_CITY?: string;
  RECIPIENT_STATE_ABBREV?: string;
  RECIPIENT_ZIP?: string;
  DELIVERY_DATE?: string;
  SALE_DATE?: string;
  CUSTOMER_NAME?: string;
  DESIGN_STATUS?: string;
  DELIVERY_STATUS?: string;
  STATUS?: string;
  TOTAL?: string;
  AMT_PAID?: string;
}

export interface TicketSearchDataset {
  dataset?: string;
  table?: string;
  rows?: TicketSearchRow[];
}

export interface MercuryMessageListRow {
  MSG_ID?: string;
  WIRE_SERVICE?: string;
  STORE_ID?: string;
  MSG_TYPE?: string;
  MSG_DIRECTION?: string;
  MSG_DATE?: string;
  DELIVERY_DATE?: string;
  MEMBER_CODE?: string;
  MERCURY_NUM?: string;
  TICKET_NUM?: string;
  TICKET_ID?: string;
  ORDER_ID?: string;
  ORDER_NUM?: string;
  ORDER_NUMBER?: string;
  USER_REFERENCE?: string;
  SALE_ID?: string;
  CATEGORY?: string;
  MSG_NOTES?: string;
  RECIPIENT_NAME?: string;
  SUMMARY_TEXT?: string;
  REQUIRES_ATTENTION?: string;
}

export interface MercuryMessageListDataset {
  dataset?: string;
  table?: string;
  rows?: MercuryMessageListRow[];
}

export interface MercuryMessageDetailRow {
  ID?: string;
  INTERNAL_MSG_ID?: string;
  TICKET_ID?: string;
  ITEM_ID?: string;
  MERC_ID?: string;
  RECIPIENT_NAME?: string;
  MSG_DATETIME?: string;
  REQ_DELIVERY_DATE?: string;
  SALE_ID?: string;
  USER_REFERENCE?: string;
}

export interface MercuryMessageDetailDataset {
  dataset?: string;
  table?: string;
  rows?: MercuryMessageDetailRow[];
}

export interface BoardCard {
  ticketId: string;
  userReference: string;
  recipientName: string;
  addressLine: string;
  cityStateZip: string;
  deliveryZip: string;
  deliveryDate: string;
  orderType: string;
  stage: StatusStage;
  stageReason: string;
  designStatus: string;
  deliveryStatus: string;
  isMarketplace: boolean;
}

export const STAGE_ORDER: StatusStage[] = [
  'incoming',
  'queued_not_designed',
  'designed',
  'saved_or_staged',
  'on_truck',
  'delivered_or_exception',
];

export const STAGE_LABELS: Record<StatusStage, string> = {
  incoming: 'Incoming',
  queued_not_designed: 'Queued / Not Designed',
  designed: 'Designed',
  saved_or_staged: 'Saved / Staged',
  on_truck: 'On Truck',
  delivered_or_exception: 'Delivered / Exception',
};
