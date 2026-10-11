# G2G + FunPay Automation

يخلي حسابك أونلاين، يعمل Boost لعروض FunPay كل ~3 ساعات عشوائي، ويبعتلك تنبيهات تيليجرام.

## إعداد تيليجرام (5 دقايق)
1. في تيليجرام افتح **@BotFather** → اكتب `/newbot` → اختار اسم → هيدّيك **Token**.
2. افتح البوت الجديد واضغط **Start** (أو ابعتله أي رسالة). *لازم تعمل ده الأول.*
3. في GitHub: Settings → Secrets and variables → Actions → New repository secret:
   - `TELEGRAM_BOT_TOKEN` = التوكن.
4. Actions → الـ workflow → **Run workflow** → فعّل `test_mode`.
   في الـ log هيظهر سطر `👉 TELEGRAM_CHAT_ID = 123456789`.
5. ضيف Secret تاني: `TELEGRAM_CHAT_ID` = الرقم ده.
6. شغّل `test_mode` تاني: لازم توصلك رسالة "🧪 اختبار: تيليجرام متوصل" + تشوف نتيجة الـ Boost.

## الإعدادات الاختيارية (Settings → Variables)
| الاسم | المعنى | الافتراضي |
|---|---|---|
| `FUNPAY_RAISE_NODES` | أرقام صفحات `/lots/<رقم>/trade` للـ Boost | `47,3050,139` |
| `FUNPAY_GAME_IDS` | لو game_id ماتلقاش تلقائياً، مثال `47:41` | — |
