/* Small synchronous preference bootstrap: prevent a bright flash on persisted night theme. */
(()=>{
 const doc=document.documentElement;
 let theme='light',choice='auto',quiet=false;
 try{theme=localStorage.getItem('ltzy-theme')==='dark'?'dark':'light';choice=localStorage.getItem('ltzy-quality')||'auto';quiet=localStorage.getItem('ltzy-reduced-motion')==='true'}catch{}
 if(!['auto','lite','full'].includes(choice))choice='auto';
 const connection=navigator.connection;
 const low=!!(connection?.saveData||(navigator.deviceMemory&&navigator.deviceMemory<=4)||(navigator.hardwareConcurrency&&navigator.hardwareConcurrency<=4));
 doc.dataset.theme=theme;doc.dataset.quality=choice==='auto'?(low?'lite':'full'):choice;
 doc.dataset.qualityChoice=choice;doc.classList.toggle('motion-quiet',quiet);
 doc.style.colorScheme=theme;
})();
