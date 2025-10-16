(function(){
  const copyBtn = document.getElementById('copyBtn');
  if (!copyBtn) return;
  const targetSelector = copyBtn.getAttribute('data-copy-target');
  const target = document.querySelector(targetSelector);
  if (!target) return;

  copyBtn.addEventListener('click', async function(){
    try{
      await navigator.clipboard.writeText(target.textContent || '');
      copyBtn.textContent = 'Copied!';
      copyBtn.disabled = true;
      setTimeout(()=>{
        copyBtn.textContent = 'Copy Lyrics';
        copyBtn.disabled = false;
      }, 1500);
    }catch(err){
      // Fallback: select + execCommand
      const range = document.createRange();
      range.selectNodeContents(target);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      try{
        document.execCommand('copy');
        copyBtn.textContent = 'Copied!';
        setTimeout(()=> copyBtn.textContent = 'Copy Lyrics', 1500);
      }catch(e){
        alert('Failed to copy. You can select and copy manually.');
      } finally {
        sel.removeAllRanges();
      }
    }
  });
})();


