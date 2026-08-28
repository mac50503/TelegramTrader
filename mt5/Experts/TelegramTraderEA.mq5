#property copyright "TelegramTrader"
#property version   "2.000"
#property strict
#property description "Cliente REST para TelegramTrader. Añada la URL en Tools > Options > Expert Advisors > WebRequest."

#include <Trade/Trade.mqh>
#include "../Include/TelegramTraderHttp.mqh"
#include "../Include/TelegramTraderJson.mqh"

#define MAX_SLOTS 10

enum EEAState
  {
   IDLE,
   CHECKING_SIGNAL,
   EXECUTING,
   POSITION_OPEN,
   REPORTING_CLOSE,
   ERROR_STATE
  };

input string ApiUrl="http://127.0.0.1:3000";
input string ApiKey="";
input string ClientId="mt5-local-01";
input string CanonicalSymbol="XAUUSD";
input string BrokerSymbol="";
input int PollIntervalSeconds=5;
input int HttpTimeoutMs=5000;
input ulong ExpertMagicNumber=26081401;
input bool EnableLiveTrading=true;
input bool RequireDemoAccountForLive=true;
input int MaxEntryDeviationPoints=50;
input int MaxEntryWaitSeconds=900;
input int MaxSlippagePoints=20;

// Cada slot representa una entrada activa (asignada por el servidor) hasta que se cierra o se
// rechaza. La capacidad del EA es fija (MAX_SLOTS); el límite real de entradas simultáneas lo
// impone el servidor vía MAX_SIMULTANEOUS_TRADES, así no hay que sincronizar dos configuraciones.
struct ActiveTrade
  {
   bool             used;
   EEAState         state;
   bool             simulatedPosition;
   bool             orderAlreadySent;
   string           signalId;
   string           tradeId;
   string           assignmentToken;
   string           groupId;
   int              legIndex;
   int              legCount;
   string           mode;
   string           symbol;
   string           side;
   double           entry;
   double           entryMin;
   double           entryMax;
   double           stopLoss;
   double           takeProfit;
   double           volume;
   double           filledPrice;
   ulong            positionTicket;
   ulong            pendingOrderTicket;
   datetime         entryWaitStarted;
   string           pendingExecutionResult;
   double           pendingExecutionPrice;
   ulong            pendingOrderTicketResult;
   ulong            pendingDealTicket;
   ulong            pendingPositionTicket;
   string           pendingRetcode;
   string           pendingDescription;
  };

ActiveTrade Slots[MAX_SLOTS];
CTelegramTraderHttp Http;
CTrade Trade;
bool Busy=false;
datetime LastContextSent=0;

int FindFreeSlot(void)
  {
   for(int i=0;i<MAX_SLOTS;i++) if(!Slots[i].used) return i;
   return -1;
  }

void ResetSlot(int i)
  {
   Slots[i].used=false; Slots[i].state=IDLE;
   Slots[i].simulatedPosition=false; Slots[i].orderAlreadySent=false;
   Slots[i].signalId=""; Slots[i].tradeId=""; Slots[i].assignmentToken=""; Slots[i].groupId="";
   Slots[i].legIndex=0; Slots[i].legCount=1;
   Slots[i].mode="SIMULATION"; Slots[i].symbol=""; Slots[i].side="";
   Slots[i].entry=0; Slots[i].entryMin=0; Slots[i].entryMax=0; Slots[i].stopLoss=0; Slots[i].takeProfit=0;
   Slots[i].volume=0; Slots[i].filledPrice=0; Slots[i].positionTicket=0; Slots[i].pendingOrderTicket=0;
   Slots[i].entryWaitStarted=0;
   Slots[i].pendingExecutionResult=""; Slots[i].pendingExecutionPrice=0;
   Slots[i].pendingOrderTicketResult=0; Slots[i].pendingDealTicket=0; Slots[i].pendingPositionTicket=0;
   Slots[i].pendingRetcode=""; Slots[i].pendingDescription="";
  }

string NewRequestId(const string action,const int slot=-1)
  {
   return ClientId+"-"+action+(slot>=0 ? "-"+IntegerToString(slot) : "")+"-"+IntegerToString((long)GetTickCount64());
  }

string SelectedBrokerSymbol(void)
  {
   return BrokerSymbol=="" ? _Symbol : BrokerSymbol;
  }

bool PostContext(void)
  {
   string symbol=SelectedBrokerSymbol();
   if(!SymbolSelect(symbol,true)) return false;
   string captured=TimeToString(TimeGMT(),TIME_DATE|TIME_SECONDS);
   StringReplace(captured,".","-");
   StringReplace(captured," ","T");
   captured+="Z";
   string body="{";
   body+="\"clientId\":\""+JsonEscape(ClientId)+"\",";
   body+="\"accountId\":\""+IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))+"\",";
   body+="\"broker\":\""+JsonEscape(AccountInfoString(ACCOUNT_COMPANY))+"\",";
   body+="\"currency\":\""+JsonEscape(AccountInfoString(ACCOUNT_CURRENCY))+"\",";
   body+="\"balance\":\""+DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE),2)+"\",";
   body+="\"equity\":\""+DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),2)+"\",";
   body+="\"capturedAt\":\""+captured+"\",";
   body+="\"symbols\":[{";
   body+="\"canonicalSymbol\":\""+JsonEscape(CanonicalSymbol)+"\",";
   body+="\"brokerSymbol\":\""+JsonEscape(symbol)+"\",";
   body+="\"digits\":"+IntegerToString((int)SymbolInfoInteger(symbol,SYMBOL_DIGITS))+",";
   body+="\"point\":\""+DoubleToString(SymbolInfoDouble(symbol,SYMBOL_POINT),10)+"\",";
   body+="\"tickSize\":\""+DoubleToString(SymbolInfoDouble(symbol,SYMBOL_TRADE_TICK_SIZE),10)+"\",";
   body+="\"tickValueProfit\":\""+DoubleToString(SymbolInfoDouble(symbol,SYMBOL_TRADE_TICK_VALUE_PROFIT),10)+"\",";
   body+="\"tickValueLoss\":\""+DoubleToString(SymbolInfoDouble(symbol,SYMBOL_TRADE_TICK_VALUE_LOSS),10)+"\",";
   body+="\"contractSize\":\""+DoubleToString(SymbolInfoDouble(symbol,SYMBOL_TRADE_CONTRACT_SIZE),4)+"\",";
   body+="\"volumeMin\":\""+DoubleToString(SymbolInfoDouble(symbol,SYMBOL_VOLUME_MIN),8)+"\",";
   body+="\"volumeMax\":\""+DoubleToString(SymbolInfoDouble(symbol,SYMBOL_VOLUME_MAX),8)+"\",";
   body+="\"volumeStep\":\""+DoubleToString(SymbolInfoDouble(symbol,SYMBOL_VOLUME_STEP),8)+"\"}]}";
   string response;
   string minuteKey=ClientId+"-context-"+IntegerToString((long)(TimeGMT()/60));
   int status=Http.Request("POST","/api/mt5/context",body,NewRequestId("context"),minuteKey,response);
   if(status>=200 && status<300) { LastContextSent=TimeCurrent(); return true; }
   PrintFormat("Context rejected. http=%d response=%s",status,response);
   return false;
  }

bool ParseAssignment(const string response,int i)
  {
   Slots[i].signalId=JsonString(response,"signalId");
   Slots[i].tradeId=JsonString(response,"tradeId");
   Slots[i].assignmentToken=JsonString(response,"assignmentToken");
   Slots[i].groupId=JsonString(response,"groupId");
   Slots[i].legIndex=(int)StringToInteger(JsonString(response,"legIndex","0"));
   Slots[i].legCount=(int)StringToInteger(JsonString(response,"legCount","1"));
   Slots[i].mode=JsonString(response,"mode","SIMULATION");
   Slots[i].symbol=JsonString(response,"symbol");
   Slots[i].side=JsonString(response,"side");
   Slots[i].entry=StringToDouble(JsonString(response,"entry","0"));
   Slots[i].entryMin=StringToDouble(JsonString(response,"entryMin",DoubleToString(Slots[i].entry,8)));
   Slots[i].entryMax=StringToDouble(JsonString(response,"entryMax",DoubleToString(Slots[i].entry,8)));
   if(Slots[i].entryMin>Slots[i].entryMax)
     {
      double swap=Slots[i].entryMin;
      Slots[i].entryMin=Slots[i].entryMax;
      Slots[i].entryMax=swap;
     }
   Slots[i].stopLoss=StringToDouble(JsonString(response,"stopLoss","0"));
   Slots[i].takeProfit=StringToDouble(JsonString(response,"takeProfit","0"));
   Slots[i].volume=StringToDouble(JsonString(response,"volume","0"));
   Slots[i].entryWaitStarted=TimeCurrent();
   return Slots[i].signalId!="" && Slots[i].assignmentToken!="" && Slots[i].symbol!="" && Slots[i].volume>0;
  }

bool BasicSignalCheck(int i)
  {
   if(Slots[i].side!="BUY" && Slots[i].side!="SELL") return false;
   if(Slots[i].entry<=0 || Slots[i].entryMin<=0 || Slots[i].entryMax<=0 || Slots[i].stopLoss<=0 || Slots[i].takeProfit<=0 || Slots[i].volume<=0) return false;
   if(Slots[i].entryMin>Slots[i].entryMax) return false;
   if(Slots[i].side=="BUY" && !(Slots[i].stopLoss<Slots[i].entryMin && Slots[i].takeProfit>Slots[i].entryMax)) return false;
   if(Slots[i].side=="SELL" && !(Slots[i].stopLoss>Slots[i].entryMax && Slots[i].takeProfit<Slots[i].entryMin)) return false;
   if(Slots[i].mode=="LIVE" && !EnableLiveTrading) return false;
   if(Slots[i].mode=="LIVE" && RequireDemoAccountForLive &&
      (ENUM_ACCOUNT_TRADE_MODE)AccountInfoInteger(ACCOUNT_TRADE_MODE)!=ACCOUNT_TRADE_MODE_DEMO) return false;
   return true;
  }

bool AcknowledgeAssignment(int i)
  {
   string body="{\"clientId\":\""+JsonEscape(ClientId)+"\",\"assignmentToken\":\""+JsonEscape(Slots[i].assignmentToken)+"\"}";
   string response;
   int status=Http.Request("POST","/api/trades/"+Slots[i].signalId+"/assigned",body,NewRequestId("assigned",i),Slots[i].signalId+"-assigned",response);
   return status>=200 && status<300;
  }

bool ReportExecution(int i,const string result,const double execution_price,const ulong order_ticket,const ulong deal_ticket,
                     const ulong position_ticket,const string retcode,const string description)
  {
   string executed=TimeToString(TimeGMT(),TIME_DATE|TIME_SECONDS);
   StringReplace(executed,".","-"); StringReplace(executed," ","T"); executed+="Z";
   string body="{";
   body+="\"clientId\":\""+JsonEscape(ClientId)+"\",\"assignmentToken\":\""+JsonEscape(Slots[i].assignmentToken)+"\",";
   body+="\"executionId\":\"EXE-"+JsonEscape(Slots[i].signalId)+"\",\"result\":\""+result+"\",";
   body+="\"requestedPrice\":\""+DoubleToString(Slots[i].entry,8)+"\",\"executionPrice\":\""+DoubleToString(execution_price,8)+"\",";
   body+="\"requestedVolume\":\""+DoubleToString(Slots[i].volume,8)+"\",\"executedVolume\":\""+DoubleToString(Slots[i].volume,8)+"\",";
   body+="\"orderTicket\":\""+IntegerToString((long)order_ticket)+"\",\"dealTicket\":\""+IntegerToString((long)deal_ticket)+"\",";
   body+="\"positionTicket\":\""+IntegerToString((long)position_ticket)+"\",\"retcode\":\""+JsonEscape(retcode)+"\",";
   body+="\"errorDescription\":\""+JsonEscape(description)+"\",\"executedAt\":\""+executed+"\"}";
   string response;
   int status=Http.Request("POST","/api/trades/"+Slots[i].signalId+"/execution",body,Slots[i].signalId+"-execution-request",Slots[i].signalId+"-execution",response);
   return status>=200 && status<300;
  }

bool ReportSlUpdate(int i,const double newStopLoss,const string reason)
  {
   string body="{\"clientId\":\""+JsonEscape(ClientId)+"\",\"assignmentToken\":\""+JsonEscape(Slots[i].assignmentToken)+"\",";
   body+="\"newStopLoss\":\""+DoubleToString(newStopLoss,8)+"\",\"reason\":\""+JsonEscape(reason)+"\"}";
   string response;
   int status=Http.Request("POST","/api/trades/"+Slots[i].signalId+"/sl-updated",body,NewRequestId("sl-updated",i),Slots[i].signalId+"-sl-updated",response);
   return status>=200 && status<300;
  }

void SetPendingExecution(int i,const string result,const double price,const ulong order_ticket,const ulong deal_ticket,
                         const ulong position_ticket,const string retcode,const string description)
  {
   Slots[i].pendingExecutionResult=result;
   Slots[i].pendingExecutionPrice=price;
   Slots[i].pendingOrderTicketResult=order_ticket;
   Slots[i].pendingDealTicket=deal_ticket;
   Slots[i].pendingPositionTicket=position_ticket;
   Slots[i].pendingRetcode=retcode;
   Slots[i].pendingDescription=description;
  }

void TryReportPendingExecution(int i)
  {
   if(Slots[i].pendingExecutionResult=="") return;
   if(!ReportExecution(i,Slots[i].pendingExecutionResult,Slots[i].pendingExecutionPrice,Slots[i].pendingOrderTicketResult,
                       Slots[i].pendingDealTicket,Slots[i].pendingPositionTicket,Slots[i].pendingRetcode,Slots[i].pendingDescription)) return;
   string completedResult=Slots[i].pendingExecutionResult;
   Slots[i].pendingExecutionResult="";
   if(completedResult=="REJECTED") ResetSlot(i);
   else Slots[i].state=POSITION_OPEN;
  }

string ActiveOrderComment(int i)
  {
   return "TT-"+Slots[i].signalId;
  }

bool SelectActivePosition(int i,double &open_price,ulong &deal_ticket)
  {
   string symbol=SelectedBrokerSymbol();
   for(int p=PositionsTotal()-1;p>=0;p--)
     {
      ulong ticket=PositionGetTicket(p);
      if(ticket==0) continue;
      if(PositionGetString(POSITION_SYMBOL)!=symbol) continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC)!=ExpertMagicNumber) continue;
      string comment=PositionGetString(POSITION_COMMENT);
      if(comment!=ActiveOrderComment(i)) continue;
      Slots[i].positionTicket=ticket;
      open_price=PositionGetDouble(POSITION_PRICE_OPEN);
      deal_ticket=0;
      ulong position_id=(ulong)PositionGetInteger(POSITION_IDENTIFIER);
      if(HistorySelectByPosition(position_id))
        {
         for(int j=HistoryDealsTotal()-1;j>=0;j--)
           {
            ulong candidate=HistoryDealGetTicket(j);
            ENUM_DEAL_ENTRY entry=(ENUM_DEAL_ENTRY)HistoryDealGetInteger(candidate,DEAL_ENTRY);
            if(entry==DEAL_ENTRY_IN || entry==DEAL_ENTRY_INOUT)
              {
               deal_ticket=candidate;
               break;
              }
           }
        }
      return true;
     }
   return false;
  }

bool RecoverPendingOrder(int i)
  {
   string symbol=SelectedBrokerSymbol();
   for(int p=OrdersTotal()-1;p>=0;p--)
     {
      ulong ticket=OrderGetTicket(p);
      if(ticket==0) continue;
      if(OrderGetString(ORDER_SYMBOL)!=symbol) continue;
      if((ulong)OrderGetInteger(ORDER_MAGIC)!=ExpertMagicNumber) continue;
      if(OrderGetString(ORDER_COMMENT)!=ActiveOrderComment(i)) continue;
      ENUM_ORDER_TYPE type=(ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      if(type!=ORDER_TYPE_BUY_LIMIT && type!=ORDER_TYPE_BUY_STOP &&
         type!=ORDER_TYPE_SELL_LIMIT && type!=ORDER_TYPE_SELL_STOP) continue;
      Slots[i].pendingOrderTicket=ticket;
      Slots[i].orderAlreadySent=true;
      Slots[i].entry=OrderGetDouble(ORDER_PRICE_OPEN);
      return true;
     }
   return false;
  }

void MonitorPendingOrder(int i)
  {
   double fill_price=0;
   ulong deal_ticket=0;
   if(SelectActivePosition(i,fill_price,deal_ticket))
     {
      ulong order_ticket=Slots[i].pendingOrderTicket;
      Slots[i].pendingOrderTicket=0;
      Slots[i].filledPrice=fill_price;
      SetPendingExecution(i,"FILLED",fill_price,order_ticket,deal_ticket,Slots[i].positionTicket,
                          "PENDING_FILLED","Pending order filled by broker");
      TryReportPendingExecution(i);
      return;
     }
   if(Slots[i].pendingOrderTicket==0 || OrderSelect(Slots[i].pendingOrderTicket)) return;
   if(!HistoryOrderSelect(Slots[i].pendingOrderTicket)) return;
   ENUM_ORDER_STATE order_state=(ENUM_ORDER_STATE)HistoryOrderGetInteger(Slots[i].pendingOrderTicket,ORDER_STATE);
   if(order_state==ORDER_STATE_FILLED || order_state==ORDER_STATE_PARTIAL) return;
   if(order_state!=ORDER_STATE_CANCELED && order_state!=ORDER_STATE_EXPIRED && order_state!=ORDER_STATE_REJECTED) return;
   string code=order_state==ORDER_STATE_EXPIRED ? "ENTRY_TIMEOUT" : "PENDING_ORDER_REMOVED";
   string description=order_state==ORDER_STATE_EXPIRED
      ? "Pending entry order expired before it was filled"
      : "Pending entry order was canceled or rejected by broker";
   ulong order_ticket=Slots[i].pendingOrderTicket;
   Slots[i].pendingOrderTicket=0;
   SetPendingExecution(i,"REJECTED",Slots[i].entry,order_ticket,0,0,code,description);
   TryReportPendingExecution(i);
  }

void PlacePendingEntry(int i,const double market_price,const double entry_tolerance)
  {
   string symbol=SelectedBrokerSymbol();
   int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
   double pending_price=0;
   ENUM_ORDER_TYPE pending_type=ORDER_TYPE_BUY_LIMIT;
   if(Slots[i].side=="BUY")
     {
      if(market_price>Slots[i].entryMax+entry_tolerance)
        {
         pending_type=ORDER_TYPE_BUY_LIMIT;
         pending_price=Slots[i].entryMax;
        }
      else
        {
         pending_type=ORDER_TYPE_BUY_STOP;
         pending_price=Slots[i].entryMin;
        }
     }
   else
     {
      if(market_price<Slots[i].entryMin-entry_tolerance)
        {
         pending_type=ORDER_TYPE_SELL_LIMIT;
         pending_price=Slots[i].entryMin;
        }
      else
        {
         pending_type=ORDER_TYPE_SELL_STOP;
         pending_price=Slots[i].entryMax;
        }
     }
   pending_price=NormalizeDouble(pending_price,digits);
   bool valid_levels=Slots[i].side=="BUY"
      ? Slots[i].stopLoss<pending_price && Slots[i].takeProfit>pending_price
      : Slots[i].stopLoss>pending_price && Slots[i].takeProfit<pending_price;
   if(!valid_levels)
     {
      Slots[i].orderAlreadySent=true;
      SetPendingExecution(i,"REJECTED",pending_price,0,0,0,"INVALID_PENDING_LEVELS",
                          "SL/TP are invalid for the pending entry price");
      TryReportPendingExecution(i);
      return;
     }
   datetime expiration=TimeCurrent()+MaxEntryWaitSeconds;
   Trade.SetExpertMagicNumber(ExpertMagicNumber);
   Trade.SetTypeFillingBySymbol(symbol);
   Trade.SetDeviationInPoints(MaxSlippagePoints);
   string comment=ActiveOrderComment(i);
   Slots[i].orderAlreadySent=true;
   bool sent=false;
   if(pending_type==ORDER_TYPE_BUY_LIMIT)
      sent=Trade.BuyLimit(Slots[i].volume,pending_price,symbol,Slots[i].stopLoss,Slots[i].takeProfit,ORDER_TIME_SPECIFIED,expiration,comment);
   else if(pending_type==ORDER_TYPE_BUY_STOP)
      sent=Trade.BuyStop(Slots[i].volume,pending_price,symbol,Slots[i].stopLoss,Slots[i].takeProfit,ORDER_TIME_SPECIFIED,expiration,comment);
   else if(pending_type==ORDER_TYPE_SELL_LIMIT)
      sent=Trade.SellLimit(Slots[i].volume,pending_price,symbol,Slots[i].stopLoss,Slots[i].takeProfit,ORDER_TIME_SPECIFIED,expiration,comment);
   else
      sent=Trade.SellStop(Slots[i].volume,pending_price,symbol,Slots[i].stopLoss,Slots[i].takeProfit,ORDER_TIME_SPECIFIED,expiration,comment);
   uint retcode=Trade.ResultRetcode();
   ulong ticket=Trade.ResultOrder();
   bool placed=sent && ticket>0 && (retcode==TRADE_RETCODE_PLACED || retcode==TRADE_RETCODE_DONE);
   if(placed)
     {
      Slots[i].entry=pending_price;
      Slots[i].pendingOrderTicket=ticket;
      PrintFormat("Pending entry placed. signal=%s ticket=%I64u type=%d price=%.*f expiration=%s",
                  Slots[i].signalId,ticket,(int)pending_type,digits,pending_price,TimeToString(expiration,TIME_DATE|TIME_SECONDS));
      return;
     }
   SetPendingExecution(i,"REJECTED",pending_price,ticket,Trade.ResultDeal(),0,IntegerToString(retcode),Trade.ResultRetcodeDescription());
   TryReportPendingExecution(i);
  }

void ExecuteActiveSignal(int i)
  {
   if(Slots[i].orderAlreadySent)
     {
      if(Slots[i].pendingOrderTicket>0) MonitorPendingOrder(i);
      else TryReportPendingExecution(i);
      return;
     }
   string symbol=SelectedBrokerSymbol();
   MqlTick tick;
   if(!SymbolInfoTick(symbol,tick)) { Slots[i].state=ERROR_STATE; return; }
   double price=Slots[i].side=="BUY" ? tick.ask : tick.bid;
   if(Slots[i].mode=="SIMULATION")
     {
      Slots[i].orderAlreadySent=true;
      Slots[i].simulatedPosition=true;
      Slots[i].entry=price;
      Slots[i].filledPrice=price;
      SetPendingExecution(i,"SIMULATED_EXECUTION",price,0,0,0,"SIMULATION","SIMULATED_EXECUTION");
      TryReportPendingExecution(i);
      return;
     }
   if(!EnableLiveTrading) { Slots[i].state=ERROR_STATE; return; }
   double point=SymbolInfoDouble(symbol,SYMBOL_POINT);
   if(point<=0 || MaxEntryDeviationPoints<0 || MaxEntryWaitSeconds<1 || MaxSlippagePoints<0)
     {
      Slots[i].orderAlreadySent=true;
      SetPendingExecution(i,"REJECTED",price,0,0,0,"INVALID_EA_LIMITS","Invalid live entry protection settings");
      TryReportPendingExecution(i);
      return;
     }
   double entryTolerance=MaxEntryDeviationPoints*point;
   if(price<Slots[i].entryMin-entryTolerance || price>Slots[i].entryMax+entryTolerance)
     {
      PlacePendingEntry(i,price,entryTolerance);
      return;
     }
   bool validAtMarket=Slots[i].side=="BUY"
      ? Slots[i].stopLoss<price && Slots[i].takeProfit>price
      : Slots[i].stopLoss>price && Slots[i].takeProfit<price;
   if(!validAtMarket)
     {
      Slots[i].orderAlreadySent=true;
      SetPendingExecution(i,"REJECTED",price,0,0,0,"INVALID_MARKET_LEVELS","SL/TP are invalid at the current market price");
      TryReportPendingExecution(i);
      return;
     }
   Trade.SetExpertMagicNumber(ExpertMagicNumber);
   Trade.SetTypeFillingBySymbol(symbol);
   Trade.SetDeviationInPoints(MaxSlippagePoints);
   string comment=ActiveOrderComment(i);
   Slots[i].orderAlreadySent=true;
   bool sent=Slots[i].side=="BUY"
      ? Trade.Buy(Slots[i].volume,symbol,0,Slots[i].stopLoss,Slots[i].takeProfit,comment)
      : Trade.Sell(Slots[i].volume,symbol,0,Slots[i].stopLoss,Slots[i].takeProfit,comment);
   uint retcode=Trade.ResultRetcode();
   bool filled=sent && (retcode==TRADE_RETCODE_DONE || retcode==TRADE_RETCODE_DONE_PARTIAL) && PositionSelect(symbol);
   if(filled)
     {
      Slots[i].positionTicket=(ulong)PositionGetInteger(POSITION_TICKET);
      double fill=Trade.ResultPrice();
      Slots[i].filledPrice=fill;
      SetPendingExecution(i,"FILLED",fill,Trade.ResultOrder(),Trade.ResultDeal(),Slots[i].positionTicket,IntegerToString(retcode),Trade.ResultRetcodeDescription());
      TryReportPendingExecution(i);
     }
   else
     {
      SetPendingExecution(i,"REJECTED",price,Trade.ResultOrder(),Trade.ResultDeal(),0,IntegerToString(retcode),Trade.ResultRetcodeDescription());
      TryReportPendingExecution(i);
     }
  }

bool ReportClose(int i,const double close_price,const double profit,const string reason)
  {
   string closed=TimeToString(TimeGMT(),TIME_DATE|TIME_SECONDS);
   StringReplace(closed,".","-"); StringReplace(closed," ","T"); closed+="Z";
   string body="{\"clientId\":\""+JsonEscape(ClientId)+"\",\"assignmentToken\":\""+JsonEscape(Slots[i].assignmentToken)+"\",";
   body+="\"closePrice\":\""+DoubleToString(close_price,8)+"\",\"grossProfit\":\""+DoubleToString(profit,2)+"\",";
   body+="\"commission\":\"0\",\"swap\":\"0\",\"netProfit\":\""+DoubleToString(profit,2)+"\",";
   body+="\"closeReason\":\""+JsonEscape(reason)+"\",\"closedAt\":\""+closed+"\"}";
   string response;
   int status=Http.Request("POST","/api/trades/"+Slots[i].signalId+"/closed",body,Slots[i].signalId+"-close-request",Slots[i].signalId+"-closed",response);
   return status>=200 && status<300;
  }

// Cuando la pierna TP1 (legIndex 0) cierra por take-profit, mueve el SL de las piernas hermanas
// (mismo groupId, legIndex>0, aún abiertas) al precio de llenado real, es decir, a breakeven.
void MoveSiblingsToBreakeven(int i)
  {
   for(int j=0;j<MAX_SLOTS;j++)
     {
      if(j==i || !Slots[j].used) continue;
      if(Slots[j].groupId!=Slots[i].groupId || Slots[j].legIndex==0) continue;
      if(Slots[j].simulatedPosition)
        {
         Slots[j].stopLoss=Slots[j].filledPrice;
         continue;
        }
      if(Slots[j].positionTicket==0 || !PositionSelectByTicket(Slots[j].positionTicket)) continue;
      double currentTp=PositionGetDouble(POSITION_TP);
      if(Trade.PositionModify(Slots[j].positionTicket,Slots[j].filledPrice,currentTp))
        {
         Slots[j].stopLoss=Slots[j].filledPrice;
         ReportSlUpdate(j,Slots[j].filledPrice,"BREAKEVEN_TP1");
        }
      else
         PrintFormat("No fue posible mover SL a breakeven. signal=%s error=%d",Slots[j].signalId,GetLastError());
     }
  }

void MonitorPosition(int i)
  {
   string symbol=SelectedBrokerSymbol();
   MqlTick tick;
   if(!SymbolInfoTick(symbol,tick)) return;
   if(Slots[i].simulatedPosition)
     {
      double price=Slots[i].side=="BUY" ? tick.bid : tick.ask;
      bool hitSl=(Slots[i].side=="BUY" && price<=Slots[i].stopLoss) || (Slots[i].side=="SELL" && price>=Slots[i].stopLoss);
      bool hitTp=(Slots[i].side=="BUY" && price>=Slots[i].takeProfit) || (Slots[i].side=="SELL" && price<=Slots[i].takeProfit);
      if(!hitSl && !hitTp) return;
      double profit=0;
      ENUM_ORDER_TYPE orderType=Slots[i].side=="BUY" ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
      if(!OrderCalcProfit(orderType,symbol,Slots[i].volume,Slots[i].entry,price,profit))
         PrintFormat("No fue posible calcular P&L simulado. error=%d",GetLastError());
      Slots[i].state=REPORTING_CLOSE;
      if(ReportClose(i,price,profit,hitSl ? "SIMULATED_SL" : "SIMULATED_TP"))
        {
         if(hitTp && Slots[i].legIndex==0) MoveSiblingsToBreakeven(i);
         ResetSlot(i);
        }
      return;
     }
   bool open=Slots[i].positionTicket>0 && PositionSelectByTicket(Slots[i].positionTicket);
   if(open) return;
   HistorySelect(TimeCurrent()-86400*7,TimeCurrent());
   double closePrice=0,profit=0,commission=0,swap=0;
   bool closedByTp=false;
   for(int j=HistoryDealsTotal()-1;j>=0;j--)
     {
      ulong ticket=HistoryDealGetTicket(j);
      if((ulong)HistoryDealGetInteger(ticket,DEAL_POSITION_ID)!=Slots[i].positionTicket) continue;
      if((ENUM_DEAL_ENTRY)HistoryDealGetInteger(ticket,DEAL_ENTRY)==DEAL_ENTRY_OUT)
        {
         closePrice=HistoryDealGetDouble(ticket,DEAL_PRICE);
         profit+=HistoryDealGetDouble(ticket,DEAL_PROFIT);
         commission+=HistoryDealGetDouble(ticket,DEAL_COMMISSION);
         swap+=HistoryDealGetDouble(ticket,DEAL_SWAP);
         if((ENUM_DEAL_REASON)HistoryDealGetInteger(ticket,DEAL_REASON)==DEAL_REASON_TP) closedByTp=true;
        }
     }
   Slots[i].state=REPORTING_CLOSE;
   if(ReportClose(i,closePrice,profit+commission+swap,"BROKER_CLOSED"))
     {
      if(closedByTp && Slots[i].legIndex==0) MoveSiblingsToBreakeven(i);
      ResetSlot(i);
     }
  }

void RecoverCurrentTrade(void)
  {
   string response;
   int status=Http.Request("GET","/api/trades/current?clientId="+ClientId,"",NewRequestId("current"),"",response);
   if(status<200 || status>=300 || !JsonBool(response,"hasTrade",false)) return;
   string items[];
   if(!JsonArrayObjects(response,"trades",items)) return;
   for(int k=0;k<ArraySize(items);k++)
     {
      int i=FindFreeSlot();
      if(i<0) { Print("No hay slots libres para recuperar todos los trades activos."); break; }
      if(!ParseAssignment(items[k],i) || !BasicSignalCheck(i)) { ResetSlot(i); continue; }
      Slots[i].used=true;
      string tradeStatus=JsonString(items[k],"status","");
      if(tradeStatus=="ASSIGNED")
        {
         if(RecoverPendingOrder(i)) { Slots[i].state=EXECUTING; continue; }
         double fill_price=0;
         ulong deal_ticket=0;
         if(SelectActivePosition(i,fill_price,deal_ticket))
           {
            Slots[i].orderAlreadySent=true;
            Slots[i].filledPrice=fill_price;
            SetPendingExecution(i,"FILLED",fill_price,0,deal_ticket,Slots[i].positionTicket,
                                "RECOVERED_FILL","Recovered a filled pending order");
           }
         Slots[i].state=EXECUTING;
         continue;
        }
      if(tradeStatus=="FILLED")
        {
         Slots[i].orderAlreadySent=true;
         if(Slots[i].mode=="SIMULATION") { Slots[i].simulatedPosition=true; Slots[i].filledPrice=Slots[i].entry; }
         else
           {
            double fill_price=0;
            ulong deal_ticket=0;
            if(!SelectActivePosition(i,fill_price,deal_ticket) && PositionSelect(SelectedBrokerSymbol()))
               Slots[i].positionTicket=(ulong)PositionGetInteger(POSITION_TICKET);
            Slots[i].filledPrice=fill_price>0 ? fill_price : PositionGetDouble(POSITION_PRICE_OPEN);
           }
         if(Slots[i].mode=="LIVE" && Slots[i].positionTicket==0) { Slots[i].state=ERROR_STATE; continue; }
         Slots[i].state=POSITION_OPEN;
         continue;
        }
      Slots[i].state=ERROR_STATE;
     }
  }

// Agota todos los slots libres en el mismo tick (en vez de uno por ciclo de polling), para que
// las piernas hermanas de una misma señal (TP1/TP2/TP3...) queden asignadas casi al mismo tiempo
// en lugar de escalonadas por varios PollIntervalSeconds.
void CheckNext(void)
  {
   while(true)
     {
      int i=FindFreeSlot();
      if(i<0) return;
      string response;
      int status=Http.Request("GET","/api/trades/next?clientId="+ClientId,"",NewRequestId("next",i),"",response);
      if(status<200 || status>=300) return;
      if(!JsonBool(response,"hasSignal",false)) return;
      if(!ParseAssignment(response,i) || !BasicSignalCheck(i) || !AcknowledgeAssignment(i)) continue;
      Slots[i].used=true;
      Slots[i].state=EXECUTING;
      ExecuteActiveSignal(i);
     }
  }

int OnInit(void)
  {
   if(ApiKey=="" || ClientId=="" || PollIntervalSeconds<1) return INIT_PARAMETERS_INCORRECT;
   PrintFormat("TelegramTraderEA safety: live=%s demoOnly=%s entryDeviationPoints=%d entryWaitSeconds=%d slippagePoints=%d accountMode=%d maxSlots=%d",
               EnableLiveTrading ? "true" : "false",RequireDemoAccountForLive ? "true" : "false",
               MaxEntryDeviationPoints,MaxEntryWaitSeconds,MaxSlippagePoints,(int)AccountInfoInteger(ACCOUNT_TRADE_MODE),MAX_SLOTS);
   for(int i=0;i<MAX_SLOTS;i++) ResetSlot(i);
   Http.Configure(ApiUrl,ApiKey,HttpTimeoutMs);
   Trade.SetExpertMagicNumber(ExpertMagicNumber);
   Trade.SetDeviationInPoints(MaxSlippagePoints);
   EventSetTimer(PollIntervalSeconds);
   PostContext();
   RecoverCurrentTrade();
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
  }

void OnTimer(void)
  {
   if(Busy) return;
   Busy=true;
   bool anyExecuting=false;
   for(int i=0;i<MAX_SLOTS;i++) if(Slots[i].used && Slots[i].state==EXECUTING) anyExecuting=true;
   if(TimeCurrent()-LastContextSent>=60 && !anyExecuting) PostContext();
   for(int i=0;i<MAX_SLOTS;i++)
     {
      if(!Slots[i].used) continue;
      if(Slots[i].state==POSITION_OPEN || Slots[i].state==REPORTING_CLOSE) MonitorPosition(i);
      else if(Slots[i].state==EXECUTING) ExecuteActiveSignal(i);
     }
   CheckNext();
   Busy=false;
  }
