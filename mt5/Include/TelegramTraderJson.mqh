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

// Splits the JSON array found under "key" into its top-level object elements (each returned
// as its own JSON substring, e.g. {"signal":{...},"trade":{...}}). Depth-aware so it copes with
// nested objects/arrays and braces inside quoted strings; used for /api/trades/current's "trades" array.
bool JsonArrayObjects(const string json,const string key,string &objects[])
  {
   ArrayResize(objects,0);
   string marker="\""+key+"\":";
   int position=StringFind(json,marker);
   if(position<0) return false;
   position+=StringLen(marker);
   while(position<StringLen(json) && StringGetCharacter(json,position)==' ') position++;
   if(position>=StringLen(json) || StringGetCharacter(json,position)!='[') return false;
   int depth=0;
   int start=-1;
   bool inString=false;
   for(int i=position+1;i<StringLen(json);i++)
     {
      ushort c=StringGetCharacter(json,i);
      if(inString)
        {
         if(c=='\\') { i++; continue; }
         if(c=='\"') inString=false;
         continue;
        }
      if(c=='\"') { inString=true; continue; }
      if(c=='{') { if(depth==0) start=i; depth++; continue; }
      if(c=='}')
        {
         depth--;
         if(depth==0 && start>=0)
           {
            int n=ArraySize(objects);
            ArrayResize(objects,n+1);
            objects[n]=StringSubstr(json,start,i-start+1);
            start=-1;
           }
         continue;
        }
      if(c==']' && depth==0) break;
     }
   return true;
  }

#endif
