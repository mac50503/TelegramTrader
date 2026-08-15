#ifndef TELEGRAM_TRADER_JSON_MQH
#define TELEGRAM_TRADER_JSON_MQH

string JsonEscape(string value)
  {
   StringReplace(value,"\\","\\\\");
   StringReplace(value,"\"","\\\"");
   StringReplace(value,"\r","\\r");
   StringReplace(value,"\n","\\n");
   return value;
  }

bool JsonBool(const string json,const string key,const bool fallback=false)
  {
   string marker="\""+key+"\":";
   int position=StringFind(json,marker);
   if(position<0) return fallback;
   position+=StringLen(marker);
   while(position<StringLen(json) && StringGetCharacter(json,position)==' ') position++;
   return StringSubstr(json,position,4)=="true";
  }

string JsonString(const string json,const string key,const string fallback="")
  {
   string marker="\""+key+"\":";
   int position=StringFind(json,marker);
   if(position<0) return fallback;
   position+=StringLen(marker);
   while(position<StringLen(json) && StringGetCharacter(json,position)==' ') position++;
   if(StringGetCharacter(json,position)=='\"')
     {
      position++;
      int finish=position;
      while(finish<StringLen(json))
        {
         if(StringGetCharacter(json,finish)=='\"' && (finish==position || StringGetCharacter(json,finish-1)!='\\')) break;
         finish++;
        }
      return StringSubstr(json,position,finish-position);
     }
   int finish=position;
   while(finish<StringLen(json) && StringGetCharacter(json,finish)!=',' && StringGetCharacter(json,finish)!='}') finish++;
   return StringSubstr(json,position,finish-position);
  }

#endif
