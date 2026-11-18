/* i.S Wholesale Communication — Firebase background push notifications */
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");

firebase.initializeApp({
 apiKey:"AIzaSyBT4Q9_biXklgD-FO9miwS3iJDl2r75wmY",
 authDomain:"i-s-wholesale-communication.firebaseapp.com",
 databaseURL:"https://i-s-wholesale-communication-default-rtdb.firebaseio.com",
 projectId:"i-s-wholesale-communication",
 storageBucket:"i-s-wholesale-communication.firebasestorage.app",
 messagingSenderId:"507434135287",
 appId:"1:507434135287:web:57c42962df651d70702df2",
 measurementId:"G-8B70ZKWWR8"
});

const messaging=firebase.messaging();
messaging.onBackgroundMessage(payload=>{
 const title=payload.notification?.title||"i.S Wholesale Communication";
 const options={
  body:payload.notification?.body||"आपके लिए एक नया अपडेट है।",
  icon:"/logo.jpg",
  badge:"/logo.jpg",
  data:{url:payload.data?.url||"/"},
  tag:payload.data?.tag||"is-wholesale-notification",
  renotify:true
 };
 return self.registration.showNotification(title,options);
});

self.addEventListener("notificationclick",event=>{
 event.notification.close();
 const target=event.notification.data?.url||"/";
 event.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{
  for(const client of list){
   if("focus" in client){client.navigate(target);return client.focus();}
  }
  return clients.openWindow?clients.openWindow(target):undefined;
 }));
});
