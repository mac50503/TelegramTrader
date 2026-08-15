#property copyright "TelegramTrader"
#property version   "1.000"
#property strict
#property description "Cliente REST para TelegramTrader. Añada la URL en Tools > Options > Expert Advisors > WebRequest."

#include <Trade/Trade.mqh>
#include "../Include/TelegramTraderHttp.mqh"
#include "../Include/TelegramTraderJson.mqh"

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
input bool EnableLiveTrading=false;

CTelegramTraderHttp Http;
CTrade Trade;
EEAState State=IDLE;
bool Busy=false;
bool SimulatedPosition=false;
bool OrderAlreadySent=false;
string ActiveSignalId="";
string ActiveTradeId="";
string AssignmentToken="";
string ActiveMode="SIMULATION";
string ActiveSymbol="";
string ActiveSide="";
double ActiveEntry=0;
double ActiveStopLoss=0;
double ActiveTakeProfit=0;
double ActiveVolume=0;
ulong ActivePositionTicket=0;
datetime LastContextSent=0;
string PendingExecutionResult="";
double PendingExecutionPrice=0;
ulong PendingOrderTicket=0;
ulong PendingDealTicket=0;
ulong PendingPositionTicket=0;
string PendingRetcode="";
string PendingDescription="";

string NewRequestId(const string action)
  {
   return ClientId+"-"+action+"-"+IntegerToString((long)GetTickCount64());
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

bool ParseAssignment(const string response)
  {
   ActiveSignalId=JsonString(response,"signalId");
   ActiveTradeId=JsonString(response,"tradeId");
   AssignmentToken=JsonString(response,"assignmentToken");
   ActiveMode=JsonString(response,"mode","SIMULATION");
   ActiveSymbol=JsonString(response,"symbol");
   ActiveSide=JsonString(response,"side");
   ActiveEntry=StringToDouble(JsonString(response,"entry","0"));
   ActiveStopLoss=StringToDouble(JsonString(response,"stopLoss","0"));
   ActiveTakeProfit=StringToDouble(JsonString(response,"takeProfit","0"));
   ActiveVolume=StringToDouble(JsonString(response,"volume","0"));
   return ActiveSignalId!="" && AssignmentToken!="" && ActiveSymbol!="" && ActiveVolume>0;
  }

bool BasicSignalCheck(void)
  {
   if(ActiveSide!="BUY" && ActiveSide!="SELL") return false;
   if(ActiveEntry<=0 || ActiveStopLoss<=0 || ActiveTakeProfit<=0 || ActiveVolume<=0) return false;
   if(ActiveSide=="BUY" && !(ActiveStopLoss<ActiveEntry && ActiveTakeProfit>ActiveEntry)) return false;
   if(ActiveSide=="SELL" && !(ActiveStopLoss>ActiveEntry && ActiveTakeProfit<ActiveEntry)) return false;
   if(ActiveMode=="LIVE" && !EnableLiveTrading) return false;
   return true;
  }

bool AcknowledgeAssignment(void)
  {
   string body="{\"clientId\":\""+JsonEscape(ClientId)+"\",\"assignmentToken\":\""+JsonEscape(AssignmentToken)+"\"}";
   string response;
   int status=Http.Request("POST","/api/trades/"+ActiveSignalId+"/assigned",body,NewRequestId("assigned"),ActiveSignalId+"-assigned",response);
   return status>=200 && status<300;
  }

bool ReportExecution(const string result,const double execution_price,const ulong order_ticket,const ulong deal_ticket,
                     const ulong position_ticket,const string retcode,const string description)
  {
   string executed=TimeToString(TimeGMT(),TIME_DATE|TIME_SECONDS);
   StringReplace(executed,".","-"); StringReplace(executed," ","T"); executed+="Z";
   string body="{";
   body+="\"clientId\":\""+JsonEscape(ClientId)+"\",\"assignmentToken\":\""+JsonEscape(AssignmentToken)+"\",";
   body+="\"executionId\":\"EXE-"+JsonEscape(ActiveSignalId)+"\",\"result\":\""+result+"\",";
   body+="\"requestedPrice\":\""+DoubleToString(ActiveEntry,8)+"\",\"executionPrice\":\""+DoubleToString(execution_price,8)+"\",";
   body+="\"requestedVolume\":\""+DoubleToString(ActiveVolume,8)+"\",\"executedVolume\":\""+DoubleToString(ActiveVolume,8)+"\",";
   body+="\"orderTicket\":\""+IntegerToString((long)order_ticket)+"\",\"dealTicket\":\""+IntegerToString((long)deal_ticket)+"\",";
   body+="\"positionTicket\":\""+IntegerToString((long)position_ticket)+"\",\"retcode\":\""+JsonEscape(retcode)+"\",";
   body+="\"errorDescription\":\""+JsonEscape(description)+"\",\"executedAt\":\""+executed+"\"}";
   string response;
   int status=Http.Request("POST","/api/trades/"+ActiveSignalId+"/execution",body,ActiveSignalId+"-execution-request",ActiveSignalId+"-execution",response);
   return status>=200 && status<300;
  }

void SetPendingExecution(const string result,const double price,const ulong order_ticket,const ulong deal_ticket,
                         const ulong position_ticket,const string retcode,const string description)
  {
   PendingExecutionResult=result;
   PendingExecutionPrice=price;
   PendingOrderTicket=order_ticket;
   PendingDealTicket=deal_ticket;
   PendingPositionTicket=position_ticket;
   PendingRetcode=retcode;
   PendingDescription=description;
  }

void TryReportPendingExecution(void)
  {
   if(PendingExecutionResult=="") return;
   if(!ReportExecution(PendingExecutionResult,PendingExecutionPrice,PendingOrderTicket,PendingDealTicket,
                       PendingPositionTicket,PendingRetcode,PendingDescription)) return;
   string completedResult=PendingExecutionResult;
   PendingExecutionResult="";
   if(completedResult=="REJECTED") { ResetActive(); State=IDLE; }
   else State=POSITION_OPEN;
  }

void ExecuteActiveSignal(void)
  {
   if(OrderAlreadySent) { TryReportPendingExecution(); return; }
   string symbol=SelectedBrokerSymbol();
   MqlTick tick;
   if(!SymbolInfoTick(symbol,tick)) { State=ERROR_STATE; return; }
   double price=ActiveSide=="BUY" ? tick.ask : tick.bid;
   OrderAlreadySent=true;
   if(ActiveMode=="SIMULATION")
     {
      SimulatedPosition=true;
      ActiveEntry=price;
      SetPendingExecution("SIMULATED_EXECUTION",price,0,0,0,"SIMULATION","SIMULATED_EXECUTION");
      TryReportPendingExecution();
      return;
     }
   if(!EnableLiveTrading) { State=ERROR_STATE; return; }
   Trade.SetExpertMagicNumber(ExpertMagicNumber);
   Trade.SetTypeFillingBySymbol(symbol);
   string comment="TT-"+ActiveSignalId;
   bool sent=ActiveSide=="BUY"
      ? Trade.Buy(ActiveVolume,symbol,0,ActiveStopLoss,ActiveTakeProfit,comment)
      : Trade.Sell(ActiveVolume,symbol,0,ActiveStopLoss,ActiveTakeProfit,comment);
   uint retcode=Trade.ResultRetcode();
   bool filled=sent && (retcode==TRADE_RETCODE_DONE || retcode==TRADE_RETCODE_DONE_PARTIAL) && PositionSelect(symbol);
   if(filled)
     {
      ActivePositionTicket=(ulong)PositionGetInteger(POSITION_TICKET);
      double fill=Trade.ResultPrice();
      SetPendingExecution("FILLED",fill,Trade.ResultOrder(),Trade.ResultDeal(),ActivePositionTicket,IntegerToString(retcode),Trade.ResultRetcodeDescription());
      TryReportPendingExecution();
     }
   else
     {
      SetPendingExecution("REJECTED",price,Trade.ResultOrder(),Trade.ResultDeal(),0,IntegerToString(retcode),Trade.ResultRetcodeDescription());
      TryReportPendingExecution();
     }
  }

bool ReportClose(const double close_price,const double profit,const string reason)
  {
   string closed=TimeToString(TimeGMT(),TIME_DATE|TIME_SECONDS);
   StringReplace(closed,".","-"); StringReplace(closed," ","T"); closed+="Z";
   string body="{\"clientId\":\""+JsonEscape(ClientId)+"\",\"assignmentToken\":\""+JsonEscape(AssignmentToken)+"\",";
   body+="\"closePrice\":\""+DoubleToString(close_price,8)+"\",\"grossProfit\":\""+DoubleToString(profit,2)+"\",";
   body+="\"commission\":\"0\",\"swap\":\"0\",\"netProfit\":\""+DoubleToString(profit,2)+"\",";
   body+="\"closeReason\":\""+JsonEscape(reason)+"\",\"closedAt\":\""+closed+"\"}";
   string response;
   int status=Http.Request("POST","/api/trades/"+ActiveSignalId+"/closed",body,ActiveSignalId+"-close-request",ActiveSignalId+"-closed",response);
   return status>=200 && status<300;
  }

void MonitorPosition(void)
  {
   string symbol=SelectedBrokerSymbol();
   MqlTick tick;
   if(!SymbolInfoTick(symbol,tick)) return;
   if(SimulatedPosition)
     {
      double price=ActiveSide=="BUY" ? tick.bid : tick.ask;
      bool hitSl=(ActiveSide=="BUY" && price<=ActiveStopLoss) || (ActiveSide=="SELL" && price>=ActiveStopLoss);
      bool hitTp=(ActiveSide=="BUY" && price>=ActiveTakeProfit) || (ActiveSide=="SELL" && price<=ActiveTakeProfit);
      if(!hitSl && !hitTp) return;
      double profit=0;
      ENUM_ORDER_TYPE orderType=ActiveSide=="BUY" ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
      if(!OrderCalcProfit(orderType,symbol,ActiveVolume,ActiveEntry,price,profit))
         PrintFormat("No fue posible calcular P&L simulado. error=%d",GetLastError());
      State=REPORTING_CLOSE;
      if(ReportClose(price,profit,hitSl ? "SIMULATED_SL" : "SIMULATED_TP")) { ResetActive(); State=IDLE; }
      return;
     }
   bool open=ActivePositionTicket>0 && PositionSelectByTicket(ActivePositionTicket);
   if(open) return;
   HistorySelect(TimeCurrent()-86400*7,TimeCurrent());
   double closePrice=0,profit=0,commission=0,swap=0;
   for(int i=HistoryDealsTotal()-1;i>=0;i--)
     {
      ulong ticket=HistoryDealGetTicket(i);
      if((ulong)HistoryDealGetInteger(ticket,DEAL_POSITION_ID)!=ActivePositionTicket) continue;
      if((ENUM_DEAL_ENTRY)HistoryDealGetInteger(ticket,DEAL_ENTRY)==DEAL_ENTRY_OUT)
        {
         closePrice=HistoryDealGetDouble(ticket,DEAL_PRICE);
         profit+=HistoryDealGetDouble(ticket,DEAL_PROFIT);
         commission+=HistoryDealGetDouble(ticket,DEAL_COMMISSION);
         swap+=HistoryDealGetDouble(ticket,DEAL_SWAP);
        }
     }
   State=REPORTING_CLOSE;
   if(ReportClose(closePrice,profit+commission+swap,"BROKER_CLOSED")) { ResetActive(); State=IDLE; }
  }

void ResetActive(void)
  {
   SimulatedPosition=false; OrderAlreadySent=false; ActiveSignalId=""; ActiveTradeId=""; AssignmentToken="";
   ActiveMode="SIMULATION"; ActiveSymbol=""; ActiveSide=""; ActiveEntry=0; ActiveStopLoss=0; ActiveTakeProfit=0;
   ActiveVolume=0; ActivePositionTicket=0;
   PendingExecutionResult=""; PendingExecutionPrice=0; PendingOrderTicket=0; PendingDealTicket=0; PendingPositionTicket=0;
   PendingRetcode=""; PendingDescription="";
  }

void RecoverCurrentTrade(void)
  {
   string response;
   int status=Http.Request("GET","/api/trades/current?clientId="+ClientId,"",NewRequestId("current"),"",response);
   if(status<200 || status>=300 || !JsonBool(response,"hasTrade",false)) { State=IDLE; return; }
   if(!ParseAssignment(response) || !BasicSignalCheck()) { State=ERROR_STATE; return; }
   string tradeStatus=JsonString(response,"status","");
   if(tradeStatus=="ASSIGNED") { State=EXECUTING; return; }
   if(tradeStatus=="FILLED")
     {
      OrderAlreadySent=true;
      if(ActiveMode=="SIMULATION") SimulatedPosition=true;
      else if(PositionSelect(SelectedBrokerSymbol())) ActivePositionTicket=(ulong)PositionGetInteger(POSITION_TICKET);
      else { State=ERROR_STATE; return; }
      State=POSITION_OPEN;
      return;
     }
   State=ERROR_STATE;
  }

void CheckNext(void)
  {
   if(PositionsTotal()>0) return;
   State=CHECKING_SIGNAL;
   string response;
   int status=Http.Request("GET","/api/trades/next?clientId="+ClientId,"",NewRequestId("next"),"",response);
   if(status<200 || status>=300) { State=IDLE; return; }
   if(!JsonBool(response,"hasSignal",false)) { State=IDLE; return; }
   if(!ParseAssignment(response) || !BasicSignalCheck() || !AcknowledgeAssignment()) { State=ERROR_STATE; return; }
   State=EXECUTING;
   ExecuteActiveSignal();
  }

int OnInit(void)
  {
   if(ApiKey=="" || ClientId=="" || PollIntervalSeconds<1) return INIT_PARAMETERS_INCORRECT;
   Http.Configure(ApiUrl,ApiKey,HttpTimeoutMs);
   Trade.SetExpertMagicNumber(ExpertMagicNumber);
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
   if(TimeCurrent()-LastContextSent>=60 && State!=EXECUTING) PostContext();
   if(State==POSITION_OPEN || State==REPORTING_CLOSE) MonitorPosition();
   else if(State==EXECUTING) ExecuteActiveSignal();
   else if(State==IDLE) CheckNext();
   Busy=false;
  }
