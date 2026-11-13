// Explicitly local fixtures: no credentials and no production project access.
process.env.FIRESTORE_EMULATOR_HOST='127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099';
const {initializeApp}=await import('firebase-admin/app');
const {getFirestore,Timestamp}=await import('firebase-admin/firestore');
const {getAuth}=await import('firebase-admin/auth');
initializeApp({projectId:'demo-meal-wizard-rules'});
const db=getFirestore();
for(const name of ['one','two']){
 const uid=`qa-${name}`,email=`${name}@mealwizard.test`;
 await getAuth().getUser(uid).catch(()=>getAuth().createUser({uid,email,password:'Local-testing-2026!',emailVerified:true}));
 await db.doc(`users/${uid}`).set({email,householdId:'qa-home',currentHouseholdId:'qa-home'});
 await db.doc(`allowlist/${email}`).set({active:true});
}
await db.doc('households/qa-home').set({members:['qa-one','qa-two'],inviteCode:'QATEST',createdAt:Timestamp.now()},{merge:true});
await db.doc('appConfig/catalogue').set({generationMode:'catalogue'});
const recipes=[['chicken','Lemon chicken with vegetables','chicken',400],['pasta','Tomato and basil pasta','pasta',200],['rice','Herbed rice','rice',150]];
for(const [id,title,name,quantity] of recipes){
 await db.doc(`recipes/qa-${id}`).set({title,sourceUrl:`https://www.recipetineats.com/${id}/`,originalServings:2,prepTime:'10 min',cookTime:'15 min',totalTime:'25 min',ingredients:[{name,quantity,unit:'g'},{name:'lemon',quantity:1,unit:'whole'}],instructions:[{text:'Prepare the ingredients and wash the vegetables.'},{text:'Cook for 15 minutes, then check that the food is cooked through.'},{text:'Serve with the prepared vegetables.'}],course:['Dinner'],tags:['Mediterranean'],notes:'Local QA fixture, not an imported source recipe.',scrapedAt:Timestamp.now(),nutrition:{calories:400,protein:25,carbs:35,fat:15}});
 await db.doc(`households/qa-home/cookbook/qa-${id}`).set({recipeId:`qa-${id}`,starred:id==='chicken',addedAt:Timestamp.now()});
}
await db.doc('households/qa-home/settings/preferences').set({sourceWeights:{},ingredientWeights:{},defaultAdults:2,defaultChildren:0,excludedIngredients:['peanuts']});
console.log('Local household fixtures ready: one@mealwizard.test and two@mealwizard.test. Password: Local-testing-2026!');
