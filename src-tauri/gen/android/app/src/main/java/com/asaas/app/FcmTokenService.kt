package com.asaas.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class FcmTokenService : FirebaseMessagingService() {
  override fun onNewToken(token: String) {
    super.onNewToken(token)
    try {
      val file = java.io.File(filesDir, "fcm-token.txt")
      file.writeText(token)
    } catch (e: Exception) {
      Log.e("FcmTokenService", "Failed to persist FCM token", e)
    }
  }

  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    Log.d("FcmTokenService", "Message received from: ${remoteMessage.from}")

    // 1. Try to get title & body from the "notification" payload (if present)
    var title = remoteMessage.notification?.title
    var body = remoteMessage.notification?.body

    // 2. If null, try to extract from the "data" payload
    if (title == null) {
      title = remoteMessage.data["title"] ?: remoteMessage.data["subject"] ?: "Asaas"
    }
    if (body == null) {
      body = remoteMessage.data["body"] ?: remoteMessage.data["message"] ?: "You have a new notification."
    }

    sendNotification(title ?: "Asaas", body ?: "")
  }

  private fun sendNotification(title: String, messageBody: String) {
    val intent = Intent(this, MainActivity::class.java)
    intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
    
    val pendingIntent = PendingIntent.getActivity(
      this, 0, intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT
    )

    val channelId = "asaas_default_channel"
    val defaultSoundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
    
    val iconId = applicationInfo.icon

    val notificationBuilder = NotificationCompat.Builder(this, channelId)
      .setSmallIcon(iconId)
      .setContentTitle(title)
      .setContentText(messageBody)
      .setAutoCancel(true)
      .setSound(defaultSoundUri)
      .setContentIntent(pendingIntent)
      .setPriority(NotificationCompat.PRIORITY_HIGH)

    val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        channelId,
        "General Notifications",
        NotificationManager.IMPORTANCE_HIGH
      )
      notificationManager.createNotificationChannel(channel)
    }

    notificationManager.notify(System.currentTimeMillis().toInt(), notificationBuilder.build())
  }
}
