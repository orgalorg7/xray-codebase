<?php
namespace App\Models;

abstract class Model
{
    protected function validate(): void {}
}

interface Keyed { public function key(): string; }

trait HasAudit { public function audit(): void {} }
