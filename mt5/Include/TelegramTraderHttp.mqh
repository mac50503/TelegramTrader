#ifndef TELEGRAM_TRADER_HTTP_MQH
#define TELEGRAM_TRADER_HTTP_MQH

class CTelegramTraderHttp
  {
private:
   string            m_base_url;
   string            m_api_key;
   int               m_timeout_ms;

public:
                     CTelegramTraderHttp(void) : m_timeout_ms(5000) {}

   void Configure(const string base_url,const string api_key,const int timeout_ms)
     {
      m_base_url=base_url;
      m_api_key=api_key;
      m_timeout_ms=timeout_ms;
     }

   int Request(const string method,const string path,const string body,const string request_id,
               const string idempotency_key,string &response)
     {
      char data[];
      char result[];
      string result_headers;
      string headers="Content-Type: application/json\r\nAccept: application/json\r\nX-API-Key: "+m_api_key+"\r\n";
      if(request_id!="") headers+="X-Request-ID: "+request_id+"\r\n";
      if(idempotency_key!="") headers+="Idempotency-Key: "+idempotency_key+"\r\n";
      StringToCharArray(body,data,0,WHOLE_ARRAY,CP_UTF8);
      if(ArraySize(data)>0) ArrayResize(data,ArraySize(data)-1);
      ResetLastError();
      int status=WebRequest(method,m_base_url+path,headers,m_timeout_ms,data,result,result_headers);
      if(status==-1)
        {
         PrintFormat("TelegramTrader WebRequest failed. error=%d path=%s",GetLastError(),path);
         response="";
         return -1;
        }
      response=CharArrayToString(result,0,WHOLE_ARRAY,CP_UTF8);
      return status;
     }
  };

#endif
