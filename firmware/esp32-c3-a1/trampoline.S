.section .text.original_panel,"ax",@progbits
.global original_panel
.type original_panel,@function
original_panel:
  .2byte 0x7159
  .2byte 0xd4a2
  j original_panel_resume
.size original_panel,.-original_panel
