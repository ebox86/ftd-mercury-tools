export interface DashboardEventRow {
  EVENT_TYP_ID: string;
  COUNT: string;
  STATUS: string;
  DATA?: string;
}

export interface MessageItem {
  CATEGORY: string;
  ID: string;
  WIRE_SERVICE: string;
  MSG_TYPE: string;
  SUMMARY_TEXT: string;
  MSG_DIRECTION: string;
  RECIPIENT_NAME: string;
  RECIPIENT_ADDRESS: string;
  RECIPIENT_CITY: string;
  RECIPIENT_STATE: string;
  RECIPIENT_STATE_ABBREV: string;
  RECIPIENT_ZIP: string;
  RECIPIENT_PHONE: string;
  FIRM_NAME: string;
  MSG_DATE: string;
  DELIVERY_DATE: string;
  SHOP_CODE: string;
  SHOP_NAME?: string;
  SHOP_PHONE?: string;
  MSG_NOTES?: string;
}

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
  FIRM_NAME: string;
  LATITUDE?: string;
  LONGITUDE?: string;
  DELIVERY_DATE: string;
  CUSTOMER_NAME: string;
  CUSTOMER_PHONE: string;
  DELIVERY_INST?: string;
  SPECIAL_INST?: string;
  CARDHOLDER_NAME?: string;
  CC_CARD_TYPE?: string;
  CC_STATUS?: string;
  CC_AUTH_DATE?: string;
  CC_AMOUNT?: string;
}

export interface BlabberItem {
  ID: string;
  MSG_DATE: string;
  SUMMARY_TEXT: string;
}

export interface DeliveryZoneItem {
  NAME: string;
  PRIORITY: string;
  NOT_DELIVERED: string;
  NOT_DESIGNED: string;
  DESIGNED: string;
  SAVED: string;
  ON_TRUCK: string;
  DELIVERED: string;
}

export interface DashboardEventsDataset {
  dataset: "DashboardEventDataset";
  tables: {
    DashboardEventTable: DashboardEventRow[];
    MessageItems: MessageItem[];
    OrderItems: OrderItem[];
    BlabberItems: BlabberItem[];
    DeliveryZones: DeliveryZoneItem[];
  };
}

export const DASHBOARD_EVENT_TYPE_BY_ID: Record<number, string> = {
  0: "DashboardEnabled",
  1: "PollingInterval",
  2: "MercuryMessages",
  3: "DeclinedCreditCard",
  4: "UnauthorizedCreditCard",
  5: "CODOrders",
  6: "PickupOrders",
  7: "IncompleteOrPendingOrders",
  8: "FiledOrders",
  9: "UnableToAccessMercuryInternet",
  10: "ProtocolsUnavailable",
  11: "BackupStatus",
  12: "NotDeliveredOrders",
  13: "StoreMainCode",
  14: "LastOrderSequenceNumber",
  15: "MercuryMessageAlert",
  16: "InternetConnectionStatus",
  17: "MobileAppEnabled"
};

export interface TicketStatusRow {
  TicketUpdated: string;
  PrintedCopy: string;
  PrintedPrinter: string;
  PrintedTime: string;
  DesignerStatus: string;
  DesignerDesigner?: string;
  DeliveryStatus: string;
  DeliveryDate: string;
  DeliveryRoute?: string;
  DeliveryDriver?: string;
  DesignerDate?: string;
  Sale_ID: string;
  Ticket_Position: string;
}

export interface TicketStatusDataset {
  dataset: "TicketStatusDataSet";
  table: "GetTicketStatus";
  byTicketId: Record<string, TicketStatusRow>;
}

export interface OrderDetailsRow {
  ID: string;
  CUST_NAME: string;
  CUST_PHONE_NBR: string;
  ORDERED_BY: string;
  ORDER_NOTES?: string;
  SECOND_CHOICE_CODE?: string;
  SECOND_CHOICE_DESC?: string;
  SALE_ID: string;
  TICKET_POSITION: string;
  SALE_DATE: string;
  COD_IND?: string;
  RECIPIENT_NAME: string;
  EMP_NAME?: string;
}

export interface OrderDetailsDataset {
  dataset: "OrderDetailsDataset";
  table: "DeliveryOrderDetailsLoad";
  rows: OrderDetailsRow[];
}

export interface OrderLifecycleRow {
  ID: string;
  STATUS_MSG_ID?: string;
  MSG_DATETIME: string;
  STATUS_CD: string;
  SENDING_INDV_ORG_ID?: string;
  SERVICE_MSG_NUM?: string;
  STATUS_TEXT: string;
  TICKET_ID: string;
  RECEIVING_INDV_ORG_ID?: string;
  EMP_ID?: string;
  EMP_NAME?: string;
  INDV_ORG_ID?: string;
  INDV_ORG_TYP_CD?: string;
  STATUS_CD_DESC?: string;
}

export interface OrderLifecycleDataset {
  dataset: "OrderLifeCycleMsgDataSet";
  table: "OLCStatusMsg";
  rows: OrderLifecycleRow[];
}

export interface ZoneSummaryRow {
  ZONE_ID: string;
  ZONE_NAME: string;
  PRIORITY_ID: string;
  PRIORITY_NAME: string;
  NOT_DELIVERED: string;
  NOT_DESIGNED: string;
  DESIGNED: string;
  SAVED: string;
  ON_TRUCK: string;
  DELIVERED: string;
}

export interface ZoneSummaryDataset {
  dataset: "ZoneSummaryDataSet";
  table: "LoadZoneSummary";
  rows: ZoneSummaryRow[];
}

export interface InProgressRouteSummaryRow {
  ROUTE_ID: string;
  ROUTE_NAME: string;
  DRIVER_NAME: string;
  TRUCK_NAME: string;
  STOP_TOTAL: string;
  STOP_COMPLETED: string;
  STOP_REMAINING: string;
  LAST_SCAN_TIME?: string;
  ETA_NEXT_STOP?: string;
  STATUS: string;
}

export interface InProgressRouteSummaryDataset {
  dataset: "InProgressRouteSummaryDataSet";
  table: "LoadInProgressRouteSummary";
  rows: InProgressRouteSummaryRow[];
}

export interface FailedDeliveryRow {
  ID: string;
  SALE_ID: string;
  TICKET_POSITION: string;
  RECIPIENT_NAME: string;
  RECIPIENT_ADDRESS: string;
  RECIPIENT_CITY: string;
  RECIPIENT_STATE_ABBREV: string;
  DELIVERY_DATE: string;
  FAIL_REASON: string;
  ROUTE_NAME?: string;
  DRIVER_NAME?: string;
  LAST_STATUS_TIME?: string;
}

export interface FailedDeliveryDataset {
  dataset: "FailedDeliveryDataSet";
  table: "LoadFailedDelivery";
  rows: FailedDeliveryRow[];
}

export interface DeliveryOrderByZoneRow {
  ID: string;
  SALE_ID: string;
  TICKET_POSITION: string;
  RECIPIENT_NAME: string;
  ZONE_ID: string;
  ZONE_NAME: string;
  PRIORITY_ID: string;
  PRIORITY_NAME: string;
  ROUTE_NAME?: string;
  DELIVERY_DATE: string;
  DESIGNED_IND: string;
  STATUS: string;
  LATITUDE?: string;
  LONGITUDE?: string;
}

export interface DeliveryOrdersByZoneDataset {
  dataset: "DeliveryOrdersByZoneDataSet";
  table: "LoadOrderByZone";
  rows: DeliveryOrderByZoneRow[];
}

export interface DeliveryOrderByRouteRow {
  ID: string;
  SALE_ID: string;
  TICKET_POSITION: string;
  RECIPIENT_NAME: string;
  RECIPIENT_ADDRESS?: string;
  RECIPIENT_CITY?: string;
  RECIPIENT_STATE_ABBREV?: string;
  ROUTE_ID: string;
  ROUTE_NAME: string;
  DRIVER_NAME?: string;
  STOP_SEQ?: string;
  DELIVERY_DATE: string;
  STATUS: string;
}

export interface DeliveryOrdersByRoutesDataset {
  dataset: "DeliveryOrdersByRoutesDataSet";
  table: "LoadOrderByRoutes";
  rows: DeliveryOrderByRouteRow[];
}

export interface MercuryMessageListRow {
  MSG_ID: string;
  WIRE_SERVICE: string;
  STORE_ID: string;
  MSG_TYPE: string;
  MSG_DIRECTION: string;
  MSG_DATE: string;
  DELIVERY_DATE: string;
  MEMBER_CODE?: string;
  MERCURY_NUM?: string;
  TICKET_NUM?: string;
  RECIPIENT_NAME?: string;
  SUMMARY_TEXT?: string;
  REQUIRES_ATTENTION?: string;
}

export interface MercuryMessageListDataset {
  dataset: "MercuryMessageListDataSet";
  table: "GetMessageList";
  rows: MercuryMessageListRow[];
}
