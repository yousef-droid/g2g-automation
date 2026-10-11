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

## تنبيهات G2G
- بتقرا نفس الطلب اللي جرس الإشعارات في الموقع بيستخدمه: `sls.g2g.com/user/<id>/notification`.
- بتوصلك: عملية بيع جديدة، تحديث على طلب شراء، طلب إلغاء جديد.
- الطلب بيحتاج توكن مدته 15 دقيقة. السكربت بيدور عليه في الكوكيز وصفحات الموقع، ولو ماقدرش يلاقيه اللوج هيقولك.
- للاختبار السريع: حط التوكن في Secret باسم `G2G_ACCESS_TOKEN` وشغّل `test_mode` فوراً (هيشتغل لحد ما يخلص الـ 15 دقيقة).
- اختياري: Variable باسم `G2G_LIST_ORDER_URL` (رابط `list_my_order` الكامل) عشان التنبيه يظهر فيه الكمية والسعر.
- **متحطش التوكن في الشات أو في صور.** حطه في GitHub Secrets بس.

### تجديد توكن G2G تلقائياً
- الموقع بيجدد التوكن بـ `POST sls.g2g.com/user/refresh_access` باستخدام كوكيز `refresh_token` و`long_lived_token` و`active_device_token`.
- السكربت بيعمل نفس الشيء لو ضفت Variable باسم `G2G_AUTO_REFRESH` = `true`.
- شغّل `test_mode` وبص على سطر `G2G refresh → HTTP ...`. لو HTTP 200 وطلع `G2G token ✅` يبقى تمام.
- أي تغيير للمفاتيح من السيرفر هيجيلك تحذير على تيليجرام.
